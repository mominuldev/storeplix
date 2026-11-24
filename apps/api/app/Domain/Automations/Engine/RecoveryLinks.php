<?php

declare(strict_types=1);

namespace App\Domain\Automations\Engine;

use App\Domain\Automations\Models\AutomationRun;
use App\Domain\Automations\Models\AutomationRunStep;
use App\Domain\Cart\CartService;
use App\Domain\Cart\Models\Cart;
use App\Domain\Cart\Models\CartItem;
use App\Domain\Orders\Models\OrderItem;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;

/**
 * POST /storefront/carts/recover (P86-16, S133): the code is looked up by sha256 inside the host's tenant and store
 * (normal RLS path), so store A's code on store B's host is unknown. Valid only while the run is running / waiting /
 * completed and its window is open. Each open clones the cart into a NEW cart with a fresh token (the original cart and
 * token are untouched), re-prices lines and applies the coupon of the last coupon message `done`.
 */
final class RecoveryLinks
{
    /** @return array{cart_token: string, next: 'checkout'|'cart'} */
    public static function restore(Store $store, string $code, string $ip): array
    {
        $run = RecoveryCodes::valid($code)
            ? AutomationRun::query()->where('store_id', $store->id)->where('recovery_code_hash', RecoveryCodes::hash($code))->first()
            : null;
        if ($run === null || ! in_array($run->status, [AutomationRun::RUNNING, AutomationRun::WAITING, AutomationRun::COMPLETED], true)
            || $run->window_ends_at === null || $run->window_ends_at->lte(now())) {
            throw new ApiException(404, 'recovery_link_invalid', "This link isn't valid any more.");
        }

        $contact = ['phone' => $run->contact_address, 'name' => null, 'email' => null];
        if ($run->subject_type === 'cart') {
            $source = Cart::query()->where('store_id', $store->id)->find($run->subject_id);
            $lines = $source === null ? [] : CartItem::query()->where('cart_id', $source->id)->orderBy('created_at')->orderBy('id')->get()
                ->map(fn (CartItem $i) => ['variant_id' => $i->variant_id, 'quantity' => (int) $i->quantity])->all();
            $contact['name'] = $source?->contact_name;
            $contact['email'] = $source?->contact_email;
        } else {
            $lines = OrderItem::query()->where('order_id', $run->subject_id)->whereNotNull('variant_id')->orderBy('position')->get()
                ->map(fn (OrderItem $i) => ['variant_id' => (string) $i->variant_id, 'quantity' => (int) $i->quantity])->all();
        }
        if ($lines === []) {
            throw new ApiException(404, 'recovery_link_invalid', "This link isn't valid any more.");
        }

        $coupon = AutomationRunStep::query()->where('run_id', $run->id)->where('action', AutomationRunStep::SEND_MESSAGE)
            ->where('status', AutomationRunStep::DONE)->orderByDesc('step_index')->get(['detail'])
            ->map(fn (AutomationRunStep $s) => $s->detail['coupon_code'] ?? null)->filter()->first();
        [, $token, $issues] = app(CartService::class)->restore($store, $lines, is_string($coupon) ? $coupon : null, $contact, $ip);

        return ['cart_token' => $token, 'next' => $issues ? 'cart' : 'checkout'];
    }
}
