<?php

declare(strict_types=1);

namespace App\Domain\Sms\Credits;

use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Sms\Jobs\SendLowSmsCreditAlert;
use App\Domain\Sms\Models\SmsCreditAccount;
use App\Domain\Sms\Models\SmsCreditLedgerEntry;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * SMS credits (PHASE-8-9A §5, P89A-5, P89A-12, P89A-18; ADR 0026). Call inside the tenant context.
 *
 * Every write takes the tenant's `sms_credit_accounts` row FOR UPDATE first (§3.3) — created lazily with
 * INSERT … ON CONFLICT (tenant_id) DO NOTHING — then appends one ledger row and moves the cached balance, so the
 * balance always equals the ledger sum and never goes below 0 (CHECK + lock). Unique indexes make a purchase grant
 * unique per invoice, consume / refund unique per SMS and an admin adjust unique per Idempotency-Key.
 */
final class SmsCreditService
{
    public const NONE = 'none';

    public const EMPTY = 'empty';

    public const LOW = 'low';

    public const HEALTHY = 'healthy';

    /** Below this the account is `low` when the alert is off (§5.1). */
    public const LOW_WITHOUT_ALERT = 100;

    public function __construct(
        private readonly TenantContext $context,
        private readonly AuditLogger $audit,
    ) {}

    /** The account row locked FOR UPDATE (created when missing). Must run inside a transaction. */
    public function lockAccount(): SmsCreditAccount
    {
        $tenantId = $this->context->requireId();
        $now = now();
        DB::table('sms_credit_accounts')->insertOrIgnore([
            'id' => strtolower((string) Str::ulid()), 'tenant_id' => $tenantId, 'balance' => 0, 'purchased_total' => 0,
            'created_at' => $now, 'updated_at' => $now,
        ]);

        return SmsCreditAccount::query()->where('tenant_id', $tenantId)->lockForUpdate()->firstOrFail();
    }

    /** Read-only: the account or null before the first credit movement. */
    public function find(): ?SmsCreditAccount
    {
        return SmsCreditAccount::query()->where('tenant_id', $this->context->requireId())->first();
    }

    public function balance(): int
    {
        return (int) ($this->find()?->balance ?? 0);
    }

    /**
     * Appends a ledger row and moves the balance of the LOCKED account. Returns the new row.
     *
     * @param  array<string, mixed>  $extra
     */
    public function append(SmsCreditAccount $account, string $type, int $credits, array $extra = [], ?Authenticatable $actor = null, string $actorType = 'system'): SmsCreditLedgerEntry
    {
        $balance = $account->balance + $credits;
        if ($balance < 0) {
            throw new ApiException(422, 'sms_credits_insufficient', 'Not enough SMS credits for this deduction.', ['balance' => $account->balance]);
        }
        $entry = new SmsCreditLedgerEntry;
        $entry->forceFill($extra + [
            'type' => $type,
            'credits' => $credits,
            'balance_after' => $balance,
            'actor_type' => $actor !== null ? $actorType : 'system',
            'actor_user_id' => $actor?->getAuthIdentifier(),
            'created_at' => now(),
        ])->save();

        $account->balance = $balance;
        DB::table('sms_credit_accounts')->where('id', $account->id)->where('tenant_id', $account->tenant_id)
            ->update(['balance' => $balance, 'updated_at' => now()]);

        return $entry;
    }

    /**
     * §5.3 step 4: credits for a server-verified, paid `sms_credits` invoice, once per invoice (the caller is inside the
     * transaction that marks the invoice paid). Returns false when the invoice was already granted.
     */
    public function grantForInvoice(BillingInvoice $invoice, ?Authenticatable $actor = null): bool
    {
        $credits = (int) $invoice->sms_credits;
        if ($invoice->kind !== BillingInvoice::SMS_CREDITS || $credits <= 0) {
            return false;
        }
        $account = $this->lockAccount();
        if (SmsCreditLedgerEntry::query()->where('type', SmsCreditLedgerEntry::PURCHASE)->where('billing_invoice_id', $invoice->id)->exists()) {
            return false;
        }
        $this->append($account, SmsCreditLedgerEntry::PURCHASE, $credits, ['billing_invoice_id' => $invoice->id], $actor, 'user');
        $threshold = $account->low_credit_threshold ?? (int) config('sms.low_credit_default', 200);
        DB::table('sms_credit_accounts')->where('id', $account->id)->where('tenant_id', $account->tenant_id)->update([
            'purchased_total' => $account->purchased_total + $credits,
            'last_purchase_at' => now(),
            'low_credit_threshold' => $threshold,
            'low_alert_sent_at' => $account->balance >= $threshold ? null : $account->low_alert_sent_at,
            'updated_at' => now(),
        ]);
        $this->audit->log('sms_credits.purchased', $account, [
            'credits' => $credits, 'invoice' => $invoice->number, 'balance_after' => $account->balance,
        ], $actor, system: $actor === null);

        return true;
    }

    /**
     * P89A-18 / §5.4: staff grant (+) or deduction (−). Replays by (tenant, Idempotency-Key) + request hash: same body →
     * the first result, another body → 409 `idempotency_key_mismatch`. Below 0 → 422 `sms_credits_insufficient`.
     */
    public function adjust(int $credits, string $reason, Authenticatable $actor, string $idempotencyKey, string $requestHash): SmsCreditLedgerEntry
    {
        return DB::transaction(function () use ($credits, $reason, $actor, $idempotencyKey, $requestHash) {
            $account = $this->lockAccount();
            $previous = SmsCreditLedgerEntry::query()->where('type', SmsCreditLedgerEntry::ADMIN_ADJUST)
                ->where('idempotency_key', $idempotencyKey)->first();
            if ($previous !== null) {
                if (! hash_equals((string) $previous->request_hash, $requestHash)) {
                    throw new ApiException(409, 'idempotency_key_mismatch', 'This Idempotency-Key was used for a different request.');
                }

                return $previous;
            }
            if ($account->balance + $credits < 0) {
                throw new ApiException(422, 'sms_credits_insufficient', "The shop has only {$account->balance} SMS credits; a deduction can't take it below 0.",
                    ['balance' => $account->balance, 'credits' => [sprintf('The shop has only %d SMS credits.', $account->balance)]]);
            }
            $entry = $this->append($account, SmsCreditLedgerEntry::ADMIN_ADJUST, $credits, [
                'reason' => $reason, 'idempotency_key' => $idempotencyKey, 'request_hash' => $requestHash,
            ], $actor, 'platform');
            $this->rearmIfAbove($account);
            $this->audit->log('sms_credits.adjusted', $account, [
                'credits' => $credits, 'balance_after' => $account->balance, 'reason' => $reason,
            ], $actor, platform: true);

            return $entry;
        });
    }

    /** P89A-12: PATCH /billing/sms-credits. Always re-arms the alert. Audited `sms_credits.alert_updated`. */
    public function setThreshold(?int $threshold, Authenticatable $actor): SmsCreditAccount
    {
        return DB::transaction(function () use ($threshold, $actor) {
            $account = $this->lockAccount();
            $from = $account->low_credit_threshold;
            DB::table('sms_credit_accounts')->where('id', $account->id)->where('tenant_id', $account->tenant_id)
                ->update(['low_credit_threshold' => $threshold, 'low_alert_sent_at' => null, 'updated_at' => now()]);
            $this->audit->log('sms_credits.alert_updated', $account, ['from' => $from, 'to' => $threshold], $actor);

            return $account->refresh();
        });
    }

    /** Re-arms the low-credit alert when the LOCKED account's balance is back at or above its threshold (§5.6). */
    public function rearmIfAbove(SmsCreditAccount $account): void
    {
        if ($account->low_credit_threshold !== null && $account->low_alert_sent_at !== null && $account->balance >= $account->low_credit_threshold) {
            DB::table('sms_credit_accounts')->where('id', $account->id)->where('tenant_id', $account->tenant_id)
                ->update(['low_alert_sent_at' => null, 'updated_at' => now()]);
            $account->low_alert_sent_at = null;
        }
    }

    /** §5.6: after a consume committed — one alert per crossing (the job's conditional UPDATE decides). */
    public function alertIfLow(SmsCreditAccount $account): void
    {
        if ($account->low_credit_threshold !== null && $account->balance < $account->low_credit_threshold && $account->low_alert_sent_at === null) {
            $tenantId = $account->tenant_id;
            DB::afterCommit(fn () => dispatch((new SendLowSmsCreditAlert)->forTenant($tenantId)));
        }
    }

    /**
     * SmsCreditsSummary (§5.1): balance, status, estimated_days_left, low_credit_threshold.
     *
     * @return array{balance: int, status: string, estimated_days_left: int|null, low_credit_threshold: int|null}
     */
    public function summary(?SmsCreditAccount $account = null): array
    {
        $account ??= $this->find();
        $balance = (int) ($account?->balance ?? 0);

        return [
            'balance' => $balance,
            'status' => $this->status($account),
            'estimated_days_left' => $this->estimatedDaysLeft($balance),
            'low_credit_threshold' => $account?->low_credit_threshold,
        ];
    }

    public function status(?SmsCreditAccount $account): string
    {
        $balance = (int) ($account?->balance ?? 0);
        if ($balance <= 0) {
            $hadCredits = $account !== null && SmsCreditLedgerEntry::query()->where('tenant_id', $account->tenant_id)
                ->where('credits', '>', 0)->whereIn('type', [SmsCreditLedgerEntry::PURCHASE, SmsCreditLedgerEntry::ADMIN_ADJUST])->exists();

            return $hadCredits ? self::EMPTY : self::NONE;
        }
        $threshold = $account?->low_credit_threshold;

        return $balance < ($threshold ?? self::LOW_WITHOUT_ALERT) ? self::LOW : self::HEALTHY;
    }

    /** floor(balance / (credits consumed − refunded in the last 30 days ÷ 30)); null when nothing was used. */
    public function estimatedDaysLeft(int $balance): ?int
    {
        $used = $this->netConsumedSince(now()->subDays(30));
        if ($used <= 0) {
            return null;
        }

        return (int) floor($balance / ($used / 30));
    }

    /** Credits consumed minus refunded since a moment (positive number). */
    public function netConsumedSince(\DateTimeInterface $since): int
    {
        $sum = (int) SmsCreditLedgerEntry::query()->where('tenant_id', $this->context->requireId())
            ->whereIn('type', [SmsCreditLedgerEntry::CONSUME, SmsCreditLedgerEntry::REFUND])->where('created_at', '>=', $since)->sum('credits');

        return max(0, -$sum);
    }
}
