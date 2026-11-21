<?php

namespace App\Domain\Stores\Http\Resources;

use App\Domain\Stores\Http\Middleware\ResolveStorefront;
use App\Domain\Stores\Models\Store;
use Illuminate\Http\Request;
use Illuminate\Http\Resources\Json\JsonResource;

/**
 * Public, render-only payload (StorefrontConfig in @storeplix/types).
 * Whitelisted fields only: no tenant id, domains, tokens or merchant data.
 *
 * @mixin Store
 */
class StorefrontConfigResource extends JsonResource
{
    public function toArray(Request $request): array
    {
        $settings = $this->settings;
        $theme = $settings?->theme ?? config('storeplix.default_theme');

        return [
            'store' => [
                'id' => $this->id,
                'name' => $this->name,
                'slug' => $this->slug,
                'status' => $this->status, // 'active' | 'draft' (suspended never resolves)
                'currency' => $this->currency,
                'logo_url' => $settings?->logo_url,
                'favicon_url' => $settings?->favicon_url,
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
