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

        $this->replace($in);
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

            'region' => ['sometimes', 'array:country,currency,timezone'],
            'region.country' => ['sometimes', 'string', 'size:2', 'regex:/^[A-Z]{2}$/'],
            'region.currency' => ['sometimes', 'string', 'in:BDT,USD'],
            'region.timezone' => ['sometimes', 'string', 'timezone:all'],
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
