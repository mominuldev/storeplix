<?php

declare(strict_types=1);

namespace App\Domain\Sms\Charging;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Limit;
use App\Domain\Marketing\CampaignAllowance;
use App\Domain\Marketing\Content\SmsParts;
use App\Domain\Orders\Notifications\SmsTemplates;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Sms\Credits\SmsCreditService;
use App\Domain\Sms\Models\SmsCreditLedgerEntry;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\SmsPreview;
use App\Domain\Sms\SmsPurposes;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\DB;

/**
 * PHASE-8-9A §4.2 (P89A-3 – P89A-6, ADR 0026 §1): decides how ONE shop-paid SMS is paid. Every sender of a tenant SMS
 * creates its `sms_messages` row (queued) and calls charge() before the provider call; account codes (`otp_*`) never
 * come here. Inside the tenant context.
 *
 * Under the tenant's `sms_credit_accounts` row lock (which serialises all charging of a tenant, so the allowance
 * count-then-insert is race-free): the allowance of the message's kind when it covers the message (transactional: 1 per
 * message against `sms_per_month`; marketing: parts against `campaign_sms_per_month`), else SMS credits (1 per part)
 * when the plan allowance is not 0, else the row is `skipped` (`no_credits`). Unlimited (null) never touches credits; a
 * 0 allowance never uses them. A message is paid wholly from one source. Idempotent per message.
 */
final class SmsCharger
{
    public function __construct(
        private readonly TenantContext $context,
        private readonly SmsCreditService $credits,
    ) {}

    /**
     * @param  int  $selfUnits  units of THIS message already included in the marketing usage count (a claimed campaign
     *                          recipient / automation step row in `sending`); the transactional row itself is excluded
     *                          automatically
     */
    public function charge(SmsMessage $message, string $text, int $selfUnits = 0): Charge
    {
        $parts = max(1, SmsParts::partsOf($text));
        $kind = SmsPurposes::kindOf($message->purpose);

        [$charge, $account] = DB::transaction(function () use ($message, $text, $parts, $kind, $selfUnits) {
            $account = $this->credits->lockAccount();
            $row = SmsMessage::query()->whereKey($message->id)->first() ?? $message;
            if ($row->charged_from !== null || $row->status === SmsMessage::SKIPPED) {
                // A replayed job: the first charge stands (consume is unique per message).
                return [Charge::fromRow($row, $account->balance), $account];
            }

            $limitKey = $kind === SmsPurposes::MARKETING ? Limit::CampaignSmsPerMonth : Limit::SmsPerMonth;
            $tenant = $this->context->tenant();
            $limit = $tenant !== null ? FeatureGate::limit($tenant, $limitKey) : 0;
            $units = $kind === SmsPurposes::MARKETING ? $parts : 1;
            $remaining = null;
            $from = null;
            if ($limit === null) {
                $from = SmsMessage::ALLOWANCE;
            } else {
                $used = $this->usedExcluding($row, $kind, $selfUnits);
                $remaining = max(0, $limit - $used);
                if ($used + $units <= $limit) {
                    $from = SmsMessage::ALLOWANCE;
                } elseif ($limit > 0 && $account->balance >= $parts) {
                    $from = SmsMessage::CREDITS;
                }
            }

            $update = [
                'kind' => $kind,
                'parts' => $parts,
                'body_preview' => SmsPreview::of($row->purpose, $text),
            ];
            if ($from === null) {
                $update += ['status' => SmsMessage::SKIPPED, 'error_code' => SmsMessage::NO_CREDITS, 'charged_from' => null, 'credits_charged' => 0];
            } else {
                $update += ['charged_from' => $from, 'credits_charged' => $from === SmsMessage::CREDITS ? $parts : 0];
            }
            DB::table('sms_messages')->where('id', $row->id)->update($update + ['updated_at' => now()]);
            if ($from === SmsMessage::CREDITS) {
                $this->credits->append($account, SmsCreditLedgerEntry::CONSUME, -$parts, ['sms_message_id' => $row->id]);
            }
            $message->forceFill($update)->syncOriginal();

            return [new Charge($from, $parts, $from === SmsMessage::CREDITS ? $parts : 0, $remaining, $account->balance), $account];
        });

        if ($charge->from === SmsMessage::CREDITS) {
            $this->credits->alertIfLow($account);
        }

        return $charge;
    }

    /**
     * When a charged row ends `failed` (final provider failure): give the credits back, once per message (§4.2).
     * Allowance-paid rows need nothing (failed rows don't count).
     */
    public function refund(SmsMessage $message): void
    {
        if ((int) $message->credits_charged <= 0 || $message->charged_from !== SmsMessage::CREDITS) {
            return;
        }
        DB::transaction(function () use ($message) {
            $account = $this->credits->lockAccount();
            if (SmsCreditLedgerEntry::query()->where('type', SmsCreditLedgerEntry::REFUND)->where('sms_message_id', $message->id)->exists()) {
                return;
            }
            $this->credits->append($account, SmsCreditLedgerEntry::REFUND, (int) $message->credits_charged, ['sms_message_id' => $message->id]);
            $this->credits->rearmIfAbove($account);
        });
    }

    /** Read-only "would this fit?" for checks that must answer before a row exists (checkout code, POS receipt, campaigns). */
    public function canAfford(string $kind, int $parts): bool
    {
        return $this->shortfall($kind, $parts) === null;
    }

    /**
     * Null when a message of `$parts` would be paid; else SmsCreditsExhaustedDetails
     * `{allowance_remaining, credits, needed}`.
     *
     * @return array{allowance_remaining: int|null, credits: int, needed: int}|null
     */
    public function shortfall(string $kind, int $parts): ?array
    {
        $parts = max(1, $parts);
        $tenant = $this->context->tenant();
        $limitKey = $kind === SmsPurposes::MARKETING ? Limit::CampaignSmsPerMonth : Limit::SmsPerMonth;
        $limit = $tenant !== null ? FeatureGate::limit($tenant, $limitKey) : 0;
        if ($limit === null) {
            return null;
        }
        $used = $kind === SmsPurposes::MARKETING ? CampaignAllowance::used('sms') : self::transactionalUsed();
        $units = $kind === SmsPurposes::MARKETING ? $parts : 1;
        if ($used + $units <= $limit) {
            return null;
        }
        $balance = $this->credits->balance();
        if ($limit > 0 && $balance >= $parts) {
            return null;
        }

        return ['allowance_remaining' => max(0, $limit - $used), 'credits' => $balance, 'needed' => $parts];
    }

    /** 402 `sms_credits_exhausted` (SmsCreditsExhaustedDetails). */
    public static function exhausted(Charge $charge): ApiException
    {
        return new ApiException(402, 'sms_credits_exhausted', 'No SMS left this month and no SMS credits. Buy SMS credits to keep sending.', [
            'allowance_remaining' => $charge->allowanceRemaining, 'credits' => $charge->balance, 'needed' => $charge->parts,
        ]);
    }

    /** `sms_per_month` usage (P5-26, amended §4.5) — the count FeatureGate reports. Inside the tenant context. */
    public static function transactionalUsed(?string $excludeId = null): int
    {
        return SmsMessage::query()->where('tenant_id', app(TenantContext::class)->requireId())
            ->whereIn('purpose', SmsTemplates::COUNTED)
            ->whereIn('status', [SmsMessage::QUEUED, SmsMessage::SENT])
            ->where(fn ($q) => $q->whereNull('charged_from')->orWhere('charged_from', '<>', SmsMessage::CREDITS))
            ->where('created_at', '>=', FeatureGate::monthStart())
            ->when($excludeId !== null, fn ($q) => $q->where('id', '<>', $excludeId))
            ->count();
    }

    private function usedExcluding(SmsMessage $row, string $kind, int $selfUnits): int
    {
        if ($kind === SmsPurposes::MARKETING) {
            return max(0, CampaignAllowance::used('sms') - max(0, $selfUnits));
        }

        return self::transactionalUsed($row->id);
    }
}
