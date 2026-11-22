<?php

namespace App\Domain\Stores\Http\Resources;

use App\Domain\Media\Http\Resources\MediaPresenter;
use App\Domain\Media\MediaMaps;
use App\Domain\Navigation\Models\StoreNavigation;
use App\Domain\Navigation\NavigationService;
use App\Domain\Pages\Models\StorePage;
use App\Domain\Payments\PaymentService;
use App\Domain\Shipping\Models\ShippingZone;
use App\Domain\Shipping\ShippingService;
use App\Domain\Stores\Http\Middleware\ResolveStorefront;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Stores\Services\ResolvedStorefront;
use App\Domain\Themes\Http\Resources\ThemeConfigPresenter;
use App\Domain\Themes\Models\StoreTheme;
use App\Domain\Themes\ThemeConfigValidator;
use App\Domain\Themes\ThemeRegistry;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * Public, render-only payload (StorefrontConfig in @storeplix/types).
 * Whitelisted fields only: no tenant id, domains, tokens, business address or merchant data.
 * Theme = active theme's PUBLISHED config; the DRAFT only with a valid preview token for this store (§3.7).
 *
 * @mixin Store
 */
class StorefrontConfigResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        $preview = (bool) $request->attributes->get(ResolveStorefront::PREVIEW_ATTRIBUTE, false);
        $settings = $this->settings;
        $settings?->loadMissing(['logo', 'favicon', 'ogImage']);
        $social = $settings?->social_links ?? [];
        $favicon = $settings?->favicon;
        $theme = $this->themeConfig($preview);

        return [
            'store' => [
                'id' => $this->id,
                'name' => $this->name,
                'slug' => $this->slug,
                'primary_host' => $this->primaryDomain?->hostname,
                'redirect_host' => $this->redirectHost($request, $preview),
                'status' => $this->status, // 'active' | 'draft' (suspended never resolves)
                'currency' => $this->currency,
                'logo_url' => MediaPresenter::url($settings?->logo, ['w320']),
                'favicon_url' => MediaPresenter::url($favicon, ['favicon_32'], originalFallback: false),
                'icons' => [
                    'apple_touch' => MediaPresenter::url($favicon, ['apple_180'], originalFallback: false),
                    'icon_192' => MediaPresenter::url($favicon, ['icon_192'], originalFallback: false),
                    'icon_512' => MediaPresenter::url($favicon, ['icon_512'], originalFallback: false),
                ],
            ],
            'contact' => StoreSettingsPresenter::contact($settings),
            'social' => [
                'facebook' => $social['facebook'] ?? null,
                'instagram' => $social['instagram'] ?? null,
                'youtube' => $social['youtube'] ?? null,
            ],
            'preview' => $preview,
            'theme' => ThemeConfigPresenter::present($theme),
            'seo' => [
                'title' => $settings?->seo_title ?: $this->name,
                'description' => $settings?->seo_description,
                'og_image_url' => MediaPresenter::url($settings?->ogImage, ['w1600', 'w1024']),
                'noindex' => (bool) ($settings?->noindex ?? false),
            ],
            'navigation' => $this->navigationMenus($preview),
            'media' => MediaMaps::storefront(ThemeConfigValidator::mediaIds($theme)),
            'commerce' => $this->commerce($settings),
        ];
    }

    /**
     * Phase 6 (P6-15): the primary host when the request host is not the primary, the request is not a valid preview,
     * and the primary or the request host is a custom domain. Platform hosts never redirect to a platform primary.
     */
    private function redirectHost(Request $request, bool $preview): ?string
    {
        $resolved = $request->attributes->get(ResolveStorefront::ATTRIBUTE);
        $primary = $this->primaryDomain;
        if ($preview || $primary === null || ! $resolved instanceof ResolvedStorefront || $resolved->hostname === $primary->hostname) {
            return null;
        }
        $requestType = StoreDomain::query()->where('store_id', $this->id)->where('hostname', $resolved->hostname)->value('type');

        return $primary->type === StoreDomain::TYPE_CUSTOM || $requestType === StoreDomain::TYPE_CUSTOM ? $primary->hostname : null;
    }

    /** StorefrontCommerce (Phase 5 §3.2): PDP delivery box, cart and footer "Pay with". */
    private function commerce(?StoreSetting $settings): array
    {
        $zones = app(ShippingService::class)->zones($this->id, activeOnly: true);

        return [
            'checkout_enabled' => $this->status === Store::STATUS_ACTIVE,
            // 5b-2 (P5B-12): COD (if enabled) + every connected and enabled gateway; P5B-13 advance rule.
            'payment_methods' => [...(($settings?->cod_enabled ?? true) ? ['cod'] : []), ...PaymentService::usableProviders($this->id)],
            'free_delivery_over_amount' => $settings?->free_delivery_over_amount !== null ? (int) $settings->free_delivery_over_amount : null,
            'delivery' => array_map(fn (ShippingZone $z) => [
                'name' => $z->name, 'charge_amount' => $z->charge_amount, 'min_days' => $z->min_days, 'max_days' => $z->max_days,
            ], $zones),
            'cod_advance' => $settings?->cod_advance === 'delivery_charge' ? 'delivery_charge' : 'none',
        ];
    }

    /** @return array<string, mixed> */
    private function themeConfig(bool $preview): array
    {
        $active = StoreTheme::query()->where('store_id', $this->id)->where('is_active', true)->first();
        $config = $preview ? $active?->draft_config : $active?->published_config;

        if ($config === null) {
            $registry = app(ThemeRegistry::class);
            $config = $registry->defaults($active?->theme_code ?? $registry->defaultCode());
        }

        return $config;
    }

    /** @return array<string, array{title: string, items: list<mixed>}> */
    private function navigationMenus(bool $preview): array
    {
        $menus = StoreNavigation::query()->where('store_id', $this->id)->get()->keyBy('handle');
        $pages = StorePage::query()->where('store_id', $this->id)->get(['id', 'slug', 'title', 'status'])->keyBy('id')->all();
        $service = app(NavigationService::class);

        $out = [];
        foreach (StoreNavigation::HANDLES as $handle) {
            $menu = $menus[$handle] ?? null;
            $out[$handle] = [
                'title' => $menu->title ?? StoreNavigation::TITLES[$handle],
                'items' => $menu ? $service->storefront($menu->items ?? [], $pages, $preview) : [],
            ];
        }

        return $out;
    }
}
