<?php

namespace App\Domain\Stores\Http\Requests;

use App\Domain\Media\Models\Media;
use App\Domain\Shared\Support\PhoneRule;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\TenantContext;
use Closure;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Rule;

/**
 * PATCH /stores/{store}/settings — partial: only sections/keys present are changed; null clears.
 * Rules mirror Phase 2 contract §1.4 exactly (WEB mirrors them in Zod).
 */
class UpdateStoreSettingsRequest extends FormRequest
{
    public const SOCIAL_HOSTS = [
        'facebook' => ['facebook.com', 'www.facebook.com', 'm.facebook.com', 'fb.com'],
        'instagram' => ['instagram.com', 'www.instagram.com'],
        'youtube' => ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be'],
    ];

    public function authorize(): bool
    {
        /** @var Store $store */
        $store = $this->route('store');

        return $this->user()->can('update', $store);
    }

    protected function prepareForValidation(): void
    {
        $in = $this->all();

        $trim = function (string $section, string $key, ?callable $transform = null) use (&$in): void {
            if (isset($in[$section]) && is_array($in[$section]) && array_key_exists($key, $in[$section]) && is_string($in[$section][$key])) {
                $value = trim($in[$section][$key]);
                $in[$section][$key] = $transform ? $transform($value) : $value;
            }
        };

        $trim('identity', 'name');
        $trim('identity', 'name_bn');
        $trim('contact', 'email', 'strtolower');
        $trim('contact', 'phone');
        $trim('contact', 'whatsapp');
        $trim('contact', 'support_hours');
        $trim('region', 'country', 'strtoupper');
        $trim('region', 'currency', 'strtoupper');
        foreach (['facebook', 'instagram', 'youtube'] as $network) {
            $trim('social', $network);
        }
        foreach (['street', 'division', 'district', 'area', 'postcode'] as $key) {
            $trim('address', $key);
        }

        if (isset($in['order_prefix']) && is_string($in['order_prefix'])) {
            $in['order_prefix'] = strtoupper(trim($in['order_prefix']));
        }

        $trim('tax', 'bin', fn ($v) => $v === '' ? null : $v);
        $trim('invoice', 'footer', fn ($v) => $v === '' ? null : $v);
        $trim('seo', 'title', fn ($v) => $v === '' ? null : $v);
        $trim('seo', 'description', fn ($v) => $v === '' ? null : $v);

        $this->replace($in);
    }

    /** @return array<string, string> */
    public function messages(): array
    {
        return [
            'order_prefix.regex' => 'Use 1–6 letters (A–Z).',
            'tax.bin.regex' => 'Enter the 9-digit BIN (or 9 digits, a dash and 4 digits).',
        ];
    }

    public function rules(): array
    {
        $tenantId = app(TenantContext::class)->requireId();
        /** @var Store $store */
        $store = $this->route('store');
        $country = is_string($this->input('region.country')) ? $this->input('region.country') : $store->country;
        $bd = $country === 'BD';

        $media = fn (string $purpose) => Rule::exists('media', 'id')
            ->where('tenant_id', $tenantId)
            ->where('purpose', $purpose)
            ->whereNot('status', Media::FAILED);

        return [
            'identity' => ['sometimes', 'array:name,name_bn,business_categories'],
            'identity.name' => ['sometimes', 'string', 'min:2', 'max:80'],
            'identity.name_bn' => ['sometimes', 'nullable', 'string', 'max:80'],
            'identity.business_categories' => ['sometimes', 'array', 'max:6'],
            'identity.business_categories.*' => ['string', 'distinct', Rule::in(config('storeplix.business_categories'))],

            'branding' => ['sometimes', 'array:logo_media_id,favicon_media_id,primary_color,secondary_color'],
            'branding.logo_media_id' => ['sometimes', 'nullable', 'string', 'ulid', $media('logo')],
            'branding.favicon_media_id' => ['sometimes', 'nullable', 'string', 'ulid', $media('favicon')],
            'branding.primary_color' => ['sometimes', 'string', 'regex:/^#[0-9a-fA-F]{6}$/'],
            'branding.secondary_color' => ['sometimes', 'string', 'regex:/^#[0-9a-fA-F]{6}$/'],

            'contact' => ['sometimes', 'array:phone,email,whatsapp,support_hours'],
            'contact.phone' => ['sometimes', 'nullable', 'string', PhoneRule::contact()],
            'contact.whatsapp' => ['sometimes', 'nullable', 'string', PhoneRule::contact()],
            'contact.email' => ['sometimes', 'nullable', 'string', 'email:rfc', 'max:254'],
            'contact.support_hours' => ['sometimes', 'nullable', 'string', 'max:80'],

            'social' => ['sometimes', 'array:facebook,instagram,youtube'],
            'social.facebook' => $this->socialRule('facebook'),
            'social.instagram' => $this->socialRule('instagram'),
            'social.youtube' => $this->socialRule('youtube'),

            'address' => ['sometimes', 'array:street,division,district,area,postcode,use_for_returns'],
            'address.street' => ['sometimes', 'nullable', 'string', 'max:255'],
            'address.division' => $bd
                ? ['sometimes', 'nullable', 'string', Rule::in(config('storeplix.bd_divisions'))]
                : ['sometimes', 'nullable', 'string', 'max:80'],
            'address.district' => ['sometimes', 'nullable', 'string', 'max:80'],
            'address.area' => ['sometimes', 'nullable', 'string', 'max:80'],
            'address.postcode' => $bd
                ? ['sometimes', 'nullable', 'string', 'regex:/^\d{4}$/']
                : ['sometimes', 'nullable', 'string', 'max:12'],
            'address.use_for_returns' => ['sometimes', 'boolean'],

            // Phase 3 §3.4: store-level SEO.
            'seo' => ['sometimes', 'array:title,description,share_image_media_id,hide_from_search'],
            'seo.title' => ['sometimes', 'nullable', 'string', 'max:70', 'regex:/^[^\x00-\x1F\x7F]*$/'],
            'seo.description' => ['sometimes', 'nullable', 'string', 'max:160', 'regex:/^[^\x00-\x1F\x7F]*$/'],
            'seo.share_image_media_id' => ['sometimes', 'nullable', 'string', 'ulid', $media('page_image')],
            'seo.hide_from_search' => ['sometimes', 'boolean'],

            'region' => ['sometimes', 'array:country,currency,timezone'],
            'region.country' => ['sometimes', 'string', 'size:2', 'regex:/^[A-Z]{2}$/'],
            'region.currency' => ['sometimes', 'string', 'in:BDT,USD'],
            'region.timezone' => ['sometimes', 'string', 'timezone:all'],

            // Phase 5 §3.5: checkout, order numbering and notifications.
            'checkout' => ['sometimes', 'array:cod_enabled,cod_advance'],
            'checkout.cod_enabled' => ['sometimes', 'boolean:strict'],
            // 5b-2 (P5B-13): require the delivery charge online before a COD order.
            'checkout.cod_advance' => ['sometimes', 'string', 'in:none,delivery_charge'],
            'order_prefix' => ['sometimes', 'string', 'regex:/^[A-Z]{1,6}$/'],
            'notifications' => ['sometimes', 'array:new_order_email,sms_language,customer_sms'],
            'notifications.new_order_email' => ['sometimes', 'boolean:strict'],
            'notifications.sms_language' => ['sometimes', 'string', 'in:bn,en'],
            'notifications.customer_sms' => ['sometimes', 'array:order_placed,order_confirmed,order_shipped,order_cancelled,order_updated,payment_link'],
            'notifications.customer_sms.*' => ['boolean:strict'],
            // Phase 5b (P5B-56, Figma 60:16858): VAT display + BIN and the invoice footer. Display only: totals and
            // tax_amount never change.
            'tax' => ['sometimes', 'array:display,rate_bps,bin'],
            'tax.display' => ['sometimes', 'string', 'in:none,included'],
            'tax.rate_bps' => ['sometimes', 'integer:strict', 'min:0', 'max:2500'],
            'tax.bin' => ['sometimes', 'nullable', 'string', 'regex:/^[0-9]{9}(-[0-9]{4})?$/'],
            'invoice' => ['sometimes', 'array:footer'],
            'invoice.footer' => ['sometimes', 'nullable', 'string', 'max:300', 'regex:/^[^\x00-\x09\x0B-\x1F\x7F]*$/u'],
        ];
    }

    /** @return list<mixed> */
    private function socialRule(string $network): array
    {
        $hosts = self::SOCIAL_HOSTS[$network];

        return ['sometimes', 'nullable', 'string', 'url', 'starts_with:https://', 'max:255',
            function (string $attribute, mixed $value, Closure $fail) use ($hosts, $network): void {
                $host = is_string($value) ? strtolower((string) parse_url($value, PHP_URL_HOST)) : '';
                if (! in_array($host, $hosts, true)) {
                    $fail('Enter a '.ucfirst($network).' link ('.implode(', ', $hosts).').');
                }
            },
        ];
    }
}
