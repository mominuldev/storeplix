<?php

namespace App\Domain\Stores\Services;

use App\Domain\Catalog\Models\Product;
use App\Domain\Orders\Models\Order;
use App\Domain\Pages\Models\StorePage;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Http\UserRef;
use App\Domain\Shipping\ShippingService;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Support\Facades\DB;

/**
 * Go-live (P5-25, roadmap 5.13). Hard requirements: an active product with an enabled variant, the fallback delivery
 * zone, a payment method (COD), a contact phone. Soft: policy pages published, first order received.
 */
class LaunchChecklist
{
    public const MESSAGES = [
        'products' => 'Add at least one active product.',
        'shipping' => 'Set your delivery charges.',
        'payments' => 'Turn on at least one way to pay.',
        'contact_phone' => 'Add a phone number customers can call.',
    ];

    public const HREFS = [
        'products' => '/products/new',
        'shipping' => '/settings/shipping',
        'payments' => '/settings/payments',
        'contact_phone' => '/settings/store',
        'policy_pages' => '/online-store/pages',
        'first_order' => '/orders',
    ];

    /** Page templates that count as policy pages (Phase 3 templates; Q17). */
    public const POLICY_TEMPLATES = ['returns', 'privacy', 'terms'];

    public function __construct(
        private readonly ShippingService $shipping,
        private readonly AuditLogger $audit,
    ) {}

    /** @return array<string, mixed> LaunchChecklist */
    public function present(Store $store): array
    {
        $done = $this->done($store);
        $items = [];
        foreach (self::HREFS as $key => $href) {
            $items[] = ['key' => $key, 'required' => isset(self::MESSAGES[$key]), 'done' => $done[$key], 'href' => $href];
        }
        $host = $store->primaryDomain()->value('hostname');

        return [
            'status' => $store->status === Store::STATUS_ACTIVE ? 'active' : 'draft',
            'can_publish' => $this->blockers($done) === [],
            'published_at' => UserRef::iso($store->published_at),
            'shop_url' => $host ? "https://{$host}" : '',
            'items' => $items,
        ];
    }

    /** @return array<string, bool> */
    public function done(Store $store): array
    {
        $settings = StoreSetting::query()->where('store_id', $store->id)->first();

        return [
            'products' => Product::query()->where('store_id', $store->id)->where('status', Product::ACTIVE)
                ->whereExists(fn ($q) => $q->select(DB::raw(1))->from('product_variants')->whereColumn('product_variants.product_id', 'products.id')
                    ->whereNull('product_variants.deleted_at')->where('product_variants.is_enabled', true))->exists(),
            'shipping' => $this->shipping->configured($store->id),
            'payments' => (bool) ($settings?->cod_enabled ?? true),
            'contact_phone' => ($settings?->contact_phone ?? '') !== '',
            'policy_pages' => StorePage::query()->where('store_id', $store->id)->where('status', StorePage::PUBLISHED)
                ->whereIn('template', self::POLICY_TEMPLATES)->exists(),
            'first_order' => Order::query()->where('store_id', $store->id)->exists(),
        ];
    }

    /** POST /stores/{store}/publish: draft → active (first time sets published_at); active → no-op. */
    public function publish(Store $store): Store
    {
        if ($store->status === Store::STATUS_ACTIVE) {
            return $store;
        }
        $blockers = $this->blockers($this->done($store));
        if ($blockers !== []) {
            throw new ApiException(409, 'launch_blocked', 'Finish these steps before you go live.', $blockers);
        }
        DB::transaction(function () use ($store) {
            $store->status = Store::STATUS_ACTIVE;
            $store->published_at ??= now();
            $store->save(); // StoreObserver flushes the host cache; the revalidation observer dispatches RevalidateStorefront
            $this->audit->log('store.published', $store);
        });

        return $store;
    }

    /** @param array<string, bool> $done @return array<string, list<string>> */
    private function blockers(array $done): array
    {
        $out = [];
        foreach (self::MESSAGES as $key => $message) {
            if (! $done[$key]) {
                $out[$key] = [$message];
            }
        }

        return $out;
    }
}
