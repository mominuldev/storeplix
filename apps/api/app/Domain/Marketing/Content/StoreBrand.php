<?php

declare(strict_types=1);

namespace App\Domain\Marketing\Content;

use App\Domain\Media\Http\Resources\MediaPresenter;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;

/** What the renderer needs to know about the store (resolved once per job / request). */
final class StoreBrand
{
    public function __construct(
        public readonly string $storeId,
        public readonly string $name,
        public readonly string $host,
        public readonly ?string $logoUrl,
        public readonly ?string $contactPhone,
        public readonly ?string $contactEmail,
    ) {}

    public static function of(Store $store): self
    {
        $store->loadMissing('primaryDomain');
        $settings = StoreSetting::query()->with('logo')->where('store_id', $store->id)->first();
        $host = $store->primaryDomain?->hostname ?? ($store->slug.'.'.config('storeplix.platform_domain', 'storeplix.test'));

        return new self(
            $store->id,
            (string) $store->name,
            strtolower((string) $host),
            $settings !== null ? MediaPresenter::url($settings->logo, ['w320']) : null,
            $settings?->contact_phone,
            $settings?->contact_email,
        );
    }
}
