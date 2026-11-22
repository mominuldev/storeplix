<?php

namespace App\Domain\Orders\Notifications;

use App\Domain\Identity\Models\User;
use App\Domain\Orders\Mail\NewOrderMerchantMail;
use App\Domain\Orders\Mail\OrderPlacedMail;
use App\Domain\Orders\Models\Order;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\Queue\TenantAware;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Mail;
use Throwable;

/** Order emails (P5-26): shopper "Your order …" and merchant "New order …". Logs carry the order id only. */
class SendOrderMail implements ShouldQueue
{
    use Queueable, TenantAware;

    public const SHOPPER_PLACED = 'shopper_placed';

    public const MERCHANT_NEW = 'merchant_new';

    public int $tries = 3;

    public function __construct(
        public readonly string $orderId,
        public readonly string $kind,
    ) {}

    public function handle(): void
    {
        $order = Order::query()->with('items')->find($this->orderId);
        if ($order === null) {
            return;
        }
        $store = Store::query()->with('primaryDomain')->findOrFail($order->store_id);
        $settings = StoreSetting::query()->where('store_id', $store->id)->first();

        try {
            if ($this->kind === self::SHOPPER_PLACED) {
                if ($order->customer_email !== null) {
                    Mail::to($order->customer_email)->send(new OrderPlacedMail($order, $store, $settings?->contact_email));
                }

                return;
            }
            $to = self::merchantRecipient($store, $settings);
            if ($to === null) {
                Log::info('order.merchant_email_skipped', ['order_id' => $order->id]);

                return;
            }
            Mail::to($to)->send(new NewOrderMerchantMail($order, $store));
        } catch (Throwable $e) {
            Log::warning('order.mail_failed', ['order_id' => $order->id, 'kind' => $this->kind]);

            throw $e;
        }
    }

    /** Store contact email; else the owner's email when verified; else nobody (logged). */
    public static function merchantRecipient(Store $store, ?StoreSetting $settings): ?string
    {
        if ($settings?->contact_email) {
            return $settings->contact_email;
        }
        $ownerId = TenantUser::query()->where('tenant_id', $store->tenant_id)->where('role', TenantUser::ROLE_OWNER)->value('user_id');
        $owner = $ownerId ? User::query()->find($ownerId) : null;

        return $owner?->email_verified_at !== null ? $owner->email : null;
    }
}
