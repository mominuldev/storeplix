<?php

declare(strict_types=1);

namespace App\Domain\Ai\Credits;

use App\Domain\Ai\Models\AiCreditAccount;
use App\Domain\Ai\Models\AiCreditLedgerEntry;
use App\Domain\Ai\Models\AiGeneration;
use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Limit;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * AI credits (PHASE-8-9D §10, P89D-33/34/35/55/56). Call inside the tenant context.
 *
 * One pool per tenant: the plan allowance (`ai_credits_per_month`, calendar month in the store timezone) first, then
 * the bonus balance granted by Store Plix staff. A request is paid wholly from one source (as P89A-3). Every write takes
 * the tenant's `ai_credit_accounts` row FOR UPDATE first (lazily created with INSERT … ON CONFLICT DO NOTHING), so 20
 * parallel requests with credits for 10 charge exactly 10 (S343). The ledger is append-only; consume and refund are
 * unique per generation (partial unique index), so a replayed job can never charge or refund twice. Allowance used in
 * a period = −Σ(allowance consume + refund rows of the period). No lock is ever held across a provider call: the
 * caller charges inside the short transaction that inserts the generation, then queues the job.
 */
final class AiCreditCharger
{
    public function __construct(
        private readonly TenantContext $context,
        private readonly AuditLogger $audit,
    ) {}

    /** @return array{product_description: int, photo_edit: int} */
    public static function costs(): array
    {
        $costs = (array) config('ai.costs');

        return ['product_description' => (int) ($costs['product_description'] ?? 1), 'photo_edit' => (int) ($costs['photo_edit'] ?? 2)];
    }

    public static function cost(string $kind): int
    {
        return self::costs()[$kind] ?? 1;
    }

    /** The (single) store's timezone; Asia/Dhaka before a store exists. Inside the tenant context. */
    public static function timezone(): string
    {
        $tz = Store::query()->value('timezone');

        return is_string($tz) && $tz !== '' ? $tz : 'Asia/Dhaka';
    }

    /** `YYYY-MM` of now in the store timezone. */
    public static function period(): string
    {
        return now(self::timezone())->format('Y-m');
    }

    /** Next allowance reset: the start of next month in the store timezone, as UTC. */
    public static function resetsAt(): Carbon
    {
        return now(self::timezone())->startOfMonth()->addMonthNoOverflow()->utc();
    }

    /** The plan allowance per month (null = unlimited; no plan has it today). */
    public function limit(): ?int
    {
        $tenant = $this->context->tenant();

        return $tenant === null ? 0 : FeatureGate::limit($tenant, Limit::AiCreditsPerMonth);
    }

    /** Allowance credits used in a period (consumes − refunds), ≥ 0. */
    public function allowanceUsed(?string $period = null): int
    {
        $sum = (int) AiCreditLedgerEntry::query()->where('tenant_id', $this->context->requireId())
            ->where('period', $period ?? self::period())->where('source', AiCreditLedgerEntry::ALLOWANCE)
            ->whereIn('type', [AiCreditLedgerEntry::CONSUME, AiCreditLedgerEntry::REFUND])->sum('credits');

        return max(0, -$sum);
    }

    /** Read-only: the account or null before the first credit movement. */
    public function find(): ?AiCreditAccount
    {
        return AiCreditAccount::query()->where('tenant_id', $this->context->requireId())->first();
    }

    /** The account row locked FOR UPDATE (created when missing). Must run inside a transaction. */
    public function lockAccount(): AiCreditAccount
    {
        $tenantId = $this->context->requireId();
        $now = now();
        DB::table('ai_credit_accounts')->insertOrIgnore([
            'id' => strtolower((string) Str::ulid()), 'tenant_id' => $tenantId, 'bonus_balance' => 0, 'created_at' => $now, 'updated_at' => $now,
        ]);

        return AiCreditAccount::query()->where('tenant_id', $tenantId)->lockForUpdate()->firstOrFail();
    }

    /**
     * §10.2: charge a generation (inside the caller's transaction, BEFORE the generation leaves `queued`). Allowance
     * first, else bonus, else 402 `ai_credits_exhausted` (details needed / available / resets_at). Returns the source.
     */
    public function charge(AiGeneration $generation, int $cost, ?Authenticatable $actor): string
    {
        $account = $this->lockAccount();
        $limit = $this->limit();
        $remaining = $limit === null ? PHP_INT_MAX : max(0, $limit - $this->allowanceUsed());
        if ($remaining >= $cost) {
            $source = AiCreditLedgerEntry::ALLOWANCE;
        } elseif ($account->bonus_balance >= $cost) {
            $source = AiCreditLedgerEntry::BONUS;
        } else {
            $available = ($limit === null ? 0 : $remaining) + $account->bonus_balance;

            throw new ApiException(402, 'ai_credits_exhausted', 'You have used all your AI credits for this month.', [
                'needed' => $cost, 'available' => $available, 'resets_at' => self::resetsAt()->toIso8601ZuluString(),
            ]);
        }
        $bonus = $account->bonus_balance - ($source === AiCreditLedgerEntry::BONUS ? $cost : 0);
        $this->append($account, AiCreditLedgerEntry::CONSUME, $source, -$cost, $bonus, self::period(), [
            'ai_generation_id' => $generation->id,
        ], $actor, 'user');

        return $source;
    }

    /**
     * P89D-56: a failed generation gets its credits back — once (unique per generation), from the source it was paid
     * from, in the period it was charged in. Returns false when there is nothing (left) to refund.
     */
    public function refund(AiGeneration $generation): bool
    {
        return DB::transaction(function () use ($generation) {
            $account = $this->lockAccount();
            $consume = AiCreditLedgerEntry::query()->where('ai_generation_id', $generation->id)->where('type', AiCreditLedgerEntry::CONSUME)->first();
            $done = AiCreditLedgerEntry::query()->where('ai_generation_id', $generation->id)->where('type', AiCreditLedgerEntry::REFUND)->exists();
            if ($consume === null || $done) {
                return false;
            }
            $credits = -$consume->credits;
            $bonus = $account->bonus_balance + ($consume->source === AiCreditLedgerEntry::BONUS ? $credits : 0);
            $this->append($account, AiCreditLedgerEntry::REFUND, (string) $consume->source, $credits, $bonus, $consume->period, [
                'ai_generation_id' => $generation->id,
            ], null, 'system');
            AiGeneration::query()->whereKey($generation->id)->update(['refunded' => true, 'updated_at' => now()]);
            $generation->refunded = true;

            return true;
        });
    }

    /**
     * P89D-35: staff grant (+) or deduction (−) of bonus credits. Replays by (tenant, Idempotency-Key) + request hash:
     * same body → the first result, another body → 409 `idempotency_key_mismatch`. Below 0 → 422 `ai_credits_insufficient`.
     */
    public function adjust(int $credits, string $reason, Authenticatable $actor, string $idempotencyKey, string $requestHash): AiCreditLedgerEntry
    {
        return DB::transaction(function () use ($credits, $reason, $actor, $idempotencyKey, $requestHash) {
            $account = $this->lockAccount();
            $previous = AiCreditLedgerEntry::query()->where('type', AiCreditLedgerEntry::ADMIN_ADJUST)->where('idempotency_key', $idempotencyKey)->first();
            if ($previous !== null) {
                if (! hash_equals((string) $previous->request_hash, $requestHash)) {
                    throw new ApiException(409, 'idempotency_key_mismatch', 'This Idempotency-Key was used for a different request.');
                }

                return $previous;
            }
            if ($account->bonus_balance + $credits < 0) {
                $message = sprintf('The shop has only %d bonus AI credits; a deduction can’t take it below 0.', $account->bonus_balance);

                throw new ApiException(422, 'ai_credits_insufficient', $message, ['bonus' => $account->bonus_balance, 'credits' => [$message]]);
            }
            $entry = $this->append($account, AiCreditLedgerEntry::ADMIN_ADJUST, null, $credits, $account->bonus_balance + $credits, self::period(), [
                'reason' => $reason, 'idempotency_key' => $idempotencyKey, 'request_hash' => $requestHash,
            ], $actor, 'platform');
            DB::table('ai_credit_accounts')->where('id', $account->id)->where('tenant_id', $account->tenant_id)->update(['last_adjusted_at' => now()]);
            $this->audit->log('ai_credits.adjusted', $account, ['credits' => $credits, 'bonus_after' => $entry->bonus_after, 'reason' => $reason], $actor, platform: true);

            return $entry;
        });
    }

    /**
     * AiCreditsSummary (§10.1).
     *
     * @return array<string, mixed>
     */
    public function summary(): array
    {
        $limit = $this->limit();
        $used = $this->allowanceUsed();
        $remaining = $limit === null ? null : max(0, $limit - $used);
        $bonus = (int) ($this->find()?->bonus_balance ?? 0);

        return [
            'allowance' => ['limit' => $limit, 'used' => $used, 'remaining' => $remaining, 'resets_at' => self::resetsAt()->toIso8601ZuluString()],
            'bonus' => $bonus,
            'available' => ($remaining ?? 0) + $bonus,
            'costs' => self::costs(),
        ];
    }

    /** @param array<string, mixed> $extra */
    private function append(AiCreditAccount $account, string $type, ?string $source, int $credits, int $bonusAfter, string $period, array $extra, ?Authenticatable $actor, string $actorType): AiCreditLedgerEntry
    {
        $entry = new AiCreditLedgerEntry;
        $entry->forceFill($extra + [
            'type' => $type,
            'source' => $source,
            'credits' => $credits,
            'bonus_after' => $bonusAfter,
            'period' => $period,
            'actor_type' => $actor !== null ? $actorType : 'system',
            'actor_user_id' => $actor?->getAuthIdentifier(),
            'created_at' => now(),
        ])->save();
        if ($bonusAfter !== $account->bonus_balance) {
            DB::table('ai_credit_accounts')->where('id', $account->id)->where('tenant_id', $account->tenant_id)
                ->update(['bonus_balance' => $bonusAfter, 'updated_at' => now()]);
            $account->bonus_balance = $bonusAfter;
        }

        return $entry;
    }
}
