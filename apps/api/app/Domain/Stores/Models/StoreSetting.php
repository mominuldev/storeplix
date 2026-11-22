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
 * @property bool $cod_enabled
 * @property int|null $free_delivery_over_amount
 * @property string|null $order_prefix
 * @property bool $notify_new_order_email
 * @property array<string, bool> $customer_sms
 * @property string $sms_language
 */
class StoreSetting extends Model
{
    use BelongsToTenant, HasUlids;

    protected $fillable = [
        'store_id', 'seo_title', 'seo_description', 'og_image_media_id', 'noindex',
        'logo_media_id', 'favicon_media_id', 'contact_phone', 'contact_email', 'whatsapp', 'support_hours',
        'social_links', 'business_address', 'use_address_for_returns',
    ];

    protected $attributes = [
        'social_links' => '{}', 'use_address_for_returns' => true, 'noindex' => false, 'cod_enabled' => true,
        'notify_new_order_email' => true, 'sms_language' => 'bn',
        'customer_sms' => '{"order_placed":true,"order_confirmed":false,"order_shipped":true,"order_cancelled":true}',
    ];

    protected function casts(): array
    {
        return [
            'social_links' => 'array',
            'business_address' => 'array',
            'use_address_for_returns' => 'boolean',
            'noindex' => 'boolean',
            'cod_enabled' => 'boolean',
            'free_delivery_over_amount' => 'integer',
            'notify_new_order_email' => 'boolean',
            'customer_sms' => 'array',
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
