<?php

declare(strict_types=1);

namespace App\Domain\FraudGuard\Http\Controllers;

use App\Domain\Billing\Feature;
use App\Domain\Billing\FeatureGate;
use App\Domain\FraudGuard\FraudGuard;
use App\Domain\FraudGuard\FraudGuardPresenter;
use App\Domain\FraudGuard\GuardSettings;
use App\Domain\FraudGuard\Http\Requests\UpdateFraudGuardSettingsRequest;
use App\Domain\FraudGuard\Models\BlockedPhone;
use App\Domain\FraudGuard\Models\FraudGuardEvent;
use App\Domain\FraudGuard\Models\OrderRiskCheck;
use App\Domain\FraudGuard\RiskTier;
use App\Domain\FraudGuard\ShopRecord;
use App\Domain\Payments\Models\PaymentLink;
use App\Domain\Shared\Support\Phone;
use App\Domain\Shared\Support\PhoneRule;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use Carbon\CarbonImmutable;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * PHASE-8-8 §6.1, §6.3, §6.4 (perm:fraud.manage on every route). Reads work on every plan (P88-15); settings writes
 * and the number check need `fake_order_guard` (402 `feature_not_in_plan`, before body validation).
 */
class FraudGuardController
{
    public function __construct(
        private readonly GuardSettings $settings,
        private readonly TenantContext $context,
        private readonly AuditLogger $audit,
    ) {}

    public function show(Store $store): JsonResponse
    {
        return new JsonResponse(['data' => FraudGuardPresenter::settings($this->settings->row($store->id))]);
    }

    public function update(Store $store): JsonResponse
    {
        $this->assertPlan();
        $request = app(UpdateFraudGuardSettingsRequest::class); // validated after the plan gate
        $input = $request->validated();
        $before = $this->settings->row($store->id);
        $changed = array_values(array_filter(array_keys($input), fn (string $k) => $before->{$k} != $input[$k]));
        $row = $this->settings->update($store->id, $input, $request->user());
        if ($changed !== []) {
            $this->audit->log('fraud.settings_updated', $store, ['fields' => $changed]);
        }

        return new JsonResponse(['data' => FraudGuardPresenter::settings($row)]);
    }

    /** POST …/settings/reset → the recommended defaults (`enabled` included). */
    public function reset(Request $request, Store $store): JsonResponse
    {
        $this->assertPlan();
        $defaults = GuardSettings::defaults();
        $defaults['enabled'] = true;
        $row = $this->settings->update($store->id, $defaults, $request->user());
        $this->audit->log('fraud.settings_updated', $store, ['reset' => true]);

        return new JsonResponse(['data' => FraudGuardPresenter::settings($row)]);
    }

    public function overview(Request $request, Store $store): JsonResponse
    {
        $input = $request->validate(['month' => ['sometimes', 'string', 'regex:/^\d{4}-(0[1-9]|1[0-2])$/']]);
        $tz = $store->timezone ?: 'Asia/Dhaka';
        $month = $input['month'] ?? CarbonImmutable::now($tz)->format('Y-m');
        $from = CarbonImmutable::createFromFormat('Y-m-d H:i:s', $month.'-01 00:00:00', $tz)->utc();
        $to = $from->setTimezone($tz)->addMonth()->utc();
        $events = FraudGuardEvent::query()->where('store_id', $store->id)->where('created_at', '>=', $from)->where('created_at', '<', $to)
            ->toBase()->groupBy('type')->selectRaw('type, count(*) as aggregate')->pluck('aggregate', 'type');
        $count = fn (string $type) => (int) ($events[$type] ?? 0);
        $collected = PaymentLink::query()->where('store_id', $store->id)->where('status', PaymentLink::PAID)
            ->where('paid_at', '>=', $from)->where('paid_at', '<', $to)
            ->whereIn('id', OrderRiskCheck::query()->select('payment_link_id')->where('store_id', $store->id)->whereNotNull('payment_link_id'))
            ->sum('amount');

        return new JsonResponse(['data' => [
            'month' => $month,
            'rules_on' => $this->settings->rulesOn($store->id),
            'rules_total' => count(GuardSettings::RULES),
            'orders_checked' => OrderRiskCheck::query()->where('store_id', $store->id)->where('created_at', '>=', $from)->where('created_at', '<', $to)->count(),
            'stopped' => [
                'held' => $count('held'),
                'blocked' => $count('blocked_checkout'),
                'duplicates' => $count('duplicate'),
                'limited' => $count('limit_reached'),
            ],
            'advance_collected_amount' => (int) $collected,
            'currency' => $store->currency ?: 'BDT',
            'blocked_count' => BlockedPhone::query()->where('store_id', $store->id)->active()->count(),
        ]], 200, ['Cache-Control' => 'private, no-store']);
    }

    /** Decision log: cursor pages of 50, newest first; `filter[type]` comma list. */
    public function events(Request $request, Store $store): JsonResponse
    {
        $types = implode('|', FraudGuardEvent::TYPES);
        $input = $request->validate([
            'filter' => ['sometimes', 'array:type'],
            'filter.type' => ['sometimes', 'string', "regex:/^({$types})(,({$types}))*$/"],
            'cursor' => ['sometimes', 'nullable', 'string', 'max:512'],
        ]);
        $page = FraudGuardEvent::query()->where('store_id', $store->id)
            ->when(isset($input['filter']['type']), fn ($q) => $q->whereIn('type', explode(',', $input['filter']['type'])))
            ->with('order')->orderByDesc('created_at')->orderByDesc('id')
            ->cursorPaginate(50, ['*'], 'cursor', $input['cursor'] ?? null);

        return new JsonResponse([
            'data' => collect($page->items())->map(fn (FraudGuardEvent $e) => FraudGuardPresenter::event($e))->values()->all(),
            'meta' => ['next_cursor' => $page->nextCursor()?->encode(), 'prev_cursor' => $page->previousCursor()?->encode(), 'per_page' => $page->perPage()],
        ]);
    }

    /** §6.3 "Check a number" (limiter `fraud-check`, audited with the masked phone and the tier only). */
    public function check(Request $request, Store $store): JsonResponse
    {
        $this->assertPlan();
        $input = $request->validate(['phone' => ['required', 'string', 'max:20', PhoneRule::bdMobile()]]);
        $phone = (string) Phone::bdMsisdn($input['phone']);
        $record = ShopRecord::for($store->id, $phone);
        $tier = RiskTier::classify($record->delivered, $record->returned, $this->settings->thresholds($store->id));
        $masked = FraudGuard::mask($phone);
        $this->audit->log('fraud.number_checked', $store, ['phone_masked' => $masked, 'tier' => $tier]);

        return new JsonResponse(['data' => [
            'phone_masked' => $masked,
            'tier' => $tier,
            'rate' => $record->rate(),
            'delivered' => $record->delivered,
            'total' => $record->total(),
            'sources' => $record->sources(),
            'blocked' => BlockedPhone::query()->where('store_id', $store->id)->where('phone', $phone)->active()->exists(),
            'last_return_on' => $record->lastReturnAt?->setTimezone($store->timezone ?: 'Asia/Dhaka')->format('Y-m-d'),
        ]], 200, ['Cache-Control' => 'private, no-store']);
    }

    private function assertPlan(): void
    {
        FeatureGate::assertAllows($this->context->tenant(), Feature::FakeOrderGuard);
    }
}
