<?php

declare(strict_types=1);

namespace App\Domain\FraudGuard;

use App\Domain\FraudGuard\Models\BlockedPhone;
use App\Domain\FraudGuard\Models\FraudGuardEvent;
use App\Domain\FraudGuard\Models\FraudGuardSetting;
use App\Domain\FraudGuard\Models\OrderRiskCheck;
use App\Domain\Identity\Models\User;
use App\Domain\Orders\Models\Order;
use App\Domain\Shared\Http\UserRef;
use App\Domain\Tenancy\Authorization\SystemRole;
use App\Domain\Tenancy\Models\TenantUser;

/** PHASE-8-8 §6.5 / §8.2 payloads (@storeplix/types: OrderGuard, FraudGuardSettings, BlockedNumber, FraudGuardEvent). */
final class FraudGuardPresenter
{
    /**
     * `Order.guard`: null when the order has no check and no hold. While `checking` the check fields are null.
     *
     * @return array<string, mixed>|null
     */
    public static function orderGuard(Order $order, ?OrderRiskCheck $check): ?array
    {
        if ($check === null && $order->guard_hold === null) {
            return null;
        }

        return [
            'hold' => $order->guard_hold,
            'tier' => $check?->tier,
            'rate' => $check?->rate,
            'reasons' => array_values($check?->reasons ?? []),
            'decision' => $check?->decision,
            'record' => $check === null ? null : [
                'total' => (int) $check->shop_total,
                'delivered' => (int) $check->shop_delivered,
                'sources' => [['key' => 'shop', 'delivered' => (int) $check->shop_delivered, 'total' => (int) $check->shop_total]],
            ],
            'payment_link_id' => $check?->payment_link_id,
            'checked_at' => UserRef::iso($check?->created_at),
        ];
    }

    /** @return array<string, mixed> FraudGuardSettings */
    public static function settings(FraudGuardSetting $s): array
    {
        $out = [];
        foreach (array_keys(GuardSettings::defaults()) as $key) {
            $out[$key] = in_array($key, FraudGuardSetting::BOOLEANS, true) ? (bool) $s->{$key} : (int) $s->{$key};
        }

        return $out + [
            'updated_by' => UserRef::of($s->updated_by !== null ? User::query()->find($s->updated_by) : null),
            'updated_at' => $s->exists ? UserRef::iso($s->updated_at) : null,
        ];
    }

    /** @return array<string, mixed> BlockedNumber */
    public static function blocked(BlockedPhone $b, bool $showPhone): array
    {
        $customer = $b->customer_id !== null ? $b->customer : null;

        return [
            'id' => $b->id,
            'phone_masked' => FraudGuard::mask($b->phone),
            'phone' => $showPhone ? $b->phone : null,
            'customer' => $customer !== null ? ['id' => $customer->id, 'name' => (string) $customer->name] : null,
            'reason' => $b->reason,
            'note' => $b->note,
            'source' => $b->source,
            'returned_count' => ShopRecord::for($b->store_id, $b->phone)->returned,
            'created_by' => $b->source === BlockedPhone::AUTO ? null : self::member($b->creator),
            'created_at' => UserRef::iso($b->created_at),
        ];
    }

    /** @return array<string, mixed> FraudGuardEvent */
    public static function event(FraudGuardEvent $e): array
    {
        $order = $e->order_id !== null ? $e->order : null;

        return [
            'id' => $e->id,
            'type' => $e->type,
            'order' => $order !== null ? ['id' => $order->id, 'number' => $order->number] : null,
            'phone_masked' => FraudGuard::mask($e->phone),
            'detail' => (object) ($e->detail ?? []),
            'created_at' => UserRef::iso($e->created_at),
        ];
    }

    /** @return array{id: string, name: string, role_label: string}|null */
    private static function member(?User $user): ?array
    {
        if ($user === null) {
            return null;
        }
        /** @var TenantUser|null $membership */
        $membership = TenantUser::query()->where('user_id', $user->id)->with('roleModel')->first();
        $label = $membership?->roleModel?->name
            ?? (SystemRole::tryFrom((string) $membership?->role)?->label() ?? 'Former member');

        return ['id' => $user->id, 'name' => (string) $user->name, 'role_label' => $label];
    }
}
