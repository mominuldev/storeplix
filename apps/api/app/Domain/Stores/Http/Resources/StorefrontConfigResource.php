<?php

namespace App\Domain\Stores\Http\Resources;

use App\Domain\Media\Http\Resources\MediaPresenter;
use App\Domain\Stores\Http\Middleware\ResolveStorefront;
use App\Domain\Stores\Models\Store;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * Public, render-only payload (StorefrontConfig in @storeplix/types).
 * Whitelisted fields only: no tenant id, domains, tokens, business address or merchant data.
 *
 * @mixin Store
 */
class StorefrontConfigResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        $settings = $this->settings;
        $settings?->loadMissing(['logo', 'favicon']);
        $theme = $settings?->theme ?? config('storeplix.default_theme');
        $social = $settings?->social_links ?? [];
        $favicon = $settings?->favicon;

        return [
            'store' => [
                'id' => $this->id,
                'name' => $this->name,
                'slug' => $this->slug,
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
            'preview' => (bool) $request->attributes->get(ResolveStorefront::PREVIEW_ATTRIBUTE, false),
            'theme' => ThemeConfigPresenter::present($theme),
            'seo' => [
                'title' => $settings?->seo_title ?: $this->name,
                'description' => $settings?->seo_description,
            ],
        ];
    }
}
