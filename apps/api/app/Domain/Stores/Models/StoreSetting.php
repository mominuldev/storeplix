<?php

namespace App\Domain\Stores\Models;

use App\Domain\Media\Models\Media;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string|null $logo_media_id
 * @property string|null $favicon_media_id
 * @property string|null $contact_phone E.164
 * @property string|null $contact_email
 * @property string|null $whatsapp E.164
 * @property string|null $support_hours
 * @property array{facebook?: string|null, instagram?: string|null, youtube?: string|null} $social_links
 * @property array{street?: string|null, division?: string|null, district?: string|null, area?: string|null, postcode?: string|null}|null $business_address
 * @property bool $use_address_for_returns
 * @property-read Media|null $logo
 * @property-read Media|null $favicon
 * @property string|null $seo_title
 * @property string|null $seo_description
 * @property string|null $og_image_media_id
 * @property bool $noindex
 * @property-read Media|null $ogImage
 */
class StoreSetting extends Model
{
    use BelongsToTenant, HasUlids;

    protected $fillable = [
        'store_id', 'seo_title', 'seo_description', 'og_image_media_id', 'noindex',
        'logo_media_id', 'favicon_media_id', 'contact_phone', 'contact_email', 'whatsapp', 'support_hours',
        'social_links', 'business_address', 'use_address_for_returns',
    ];

    protected $attributes = ['social_links' => '{}', 'use_address_for_returns' => true, 'noindex' => false];

    protected function casts(): array
    {
        return [
            'social_links' => 'array',
            'business_address' => 'array',
            'use_address_for_returns' => 'boolean',
            'noindex' => 'boolean',
        ];
    }

    public function logo(): BelongsTo
    {
        return $this->belongsTo(Media::class, 'logo_media_id');
    }

    public function favicon(): BelongsTo
    {
        return $this->belongsTo(Media::class, 'favicon_media_id');
    }

    public function ogImage(): BelongsTo
    {
        return $this->belongsTo(Media::class, 'og_image_media_id');
    }

    public function store(): BelongsTo
    {
        return $this->belongsTo(Store::class);
    }
}
