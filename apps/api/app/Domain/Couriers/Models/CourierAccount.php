<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Integrations\Casts\EncryptedCredentials;
use App\Domain\Integrations\IntegrationCredentials;
use App\Domain\Shipping\Models\PickupLocation;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;
use SensitiveParameter;

/**
 * A merchant courier account (P5B-31/32), one per store and provider. `credentials` is IntegrationCredentials
 * ciphertext (steadfast {api_key, secret_key}; pathao {client_id, client_secret, username, password}; redx
 * {access_token}); the webhook secret is stored twice: sha256 (`webhook_secret_hash`, for lookups/compare) and
 * encrypted (`webhook_secret_encrypted`, Pathao compares plain values). All three plus `route_key` are hidden from
 * every serialisation; nothing is mass-assignable (S39).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $provider
 * @property string $mode
 * @property string $status
 * @property array<string, string> $credentials
 * @property string|null $credentials_hint
 * @property string|null $webhook_secret_hash
 * @property string|null $webhook_secret_encrypted
 * @property string $route_key
 * @property array<string, mixed> $settings
 * @property string|null $pickup_location_id
 * @property bool $is_default
 * @property Carbon|null $last_synced_at
 * @property Carbon|null $last_webhook_at
 * @property Carbon|null $last_checked_at
 * @property string|null $last_error_code
 * @property string|null $connected_by
 * @property Carbon|null $connected_at
 * @property int $revision
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read User|null $connectedBy
 * @property-read Store $store
 * @property-read PickupLocation|null $pickupLocation
 */
class CourierAccount extends Model
{
    use BelongsToTenant, HasUlids;

    public const STEADFAST = 'steadfast';

    public const PATHAO = 'pathao';

    public const REDX = 'redx';

    /** Driver order P5B-30; also the list order of GET /couriers. */
    public const PROVIDERS = [self::STEADFAST, self::PATHAO, self::REDX];

    public const SANDBOX = 'sandbox';

    public const LIVE = 'live';

    public const MODES = [self::SANDBOX, self::LIVE];

    public const CONNECTED = 'connected';

    public const ERROR = 'error';

    public const DISCONNECTED = 'disconnected';

    /** Presented for providers without a row. */
    public const NOT_CONNECTED = 'not_connected';

    /** Credential fields per provider (ConnectCourierInput) and their max lengths (openapi). */
    public const CREDENTIAL_FIELDS = [
        self::STEADFAST => ['api_key' => 128, 'secret_key' => 128],
        self::PATHAO => ['client_id' => 128, 'client_secret' => 256, 'username' => 254, 'password' => 128],
        self::REDX => ['access_token' => 2048],
    ];

    /** The field whose last 4 characters form credentials_hint. */
    public const HINT_FIELD = [self::STEADFAST => 'api_key', self::PATHAO => 'client_id', self::REDX => 'access_token'];

    /** Providers whose webhook secret we hold (Steadfast bearer we issue; Pathao X-PATHAO-Signature). RedX: poll only. */
    public const WEBHOOK_PROVIDERS = [self::STEADFAST, self::PATHAO];

    /** P5B-32 defaults (CourierSettings). */
    public const DEFAULT_SETTINGS = [
        'pickup_location_id' => null,
        'parcel_description' => '{items}',
        'default_weight_grams' => 500,
    ];

    protected $fillable = [];

    protected $hidden = ['credentials', 'route_key', 'webhook_secret_hash', 'webhook_secret_encrypted'];

    protected $attributes = ['is_default' => false, 'revision' => 1, 'settings' => '{}'];

    protected function casts(): array
    {
        return [
            'credentials' => EncryptedCredentials::class,
            'settings' => 'array',
            'is_default' => 'boolean',
            'last_synced_at' => 'datetime',
            'last_webhook_at' => 'datetime',
            'last_checked_at' => 'datetime',
            'connected_at' => 'datetime',
            'revision' => 'integer',
        ];
    }

    public function store(): BelongsTo
    {
        return $this->belongsTo(Store::class);
    }

    public function connectedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'connected_by');
    }

    public function pickupLocation(): BelongsTo
    {
        return $this->belongsTo(PickupLocation::class);
    }

    public function isConnected(): bool
    {
        return $this->status === self::CONNECTED;
    }

    /** Settings with P5B-32 defaults and the provider-specific keys; `pickup_location_id` mirrors the column. */
    public function resolvedSettings(): array
    {
        $settings = array_merge(self::DEFAULT_SETTINGS, is_array($this->settings) ? $this->settings : []);
        $settings['pickup_location_id'] = $this->pickup_location_id;
        if ($this->provider === self::PATHAO) {
            $settings += ['pathao_store_id' => null, 'delivery_type' => 48, 'item_type' => 2];
        }
        if ($this->provider === self::REDX) {
            $settings += ['redx_pickup_store_id' => null];
        }

        return $settings;
    }

    /** Provider base URL for this account's mode, from config only (S27). Null when not configured. */
    public function baseUrl(): ?string
    {
        return self::baseUrlFor($this->provider, $this->mode);
    }

    public static function baseUrlFor(string $provider, string $mode): ?string
    {
        $url = config("couriers.providers.{$provider}.base_urls.{$mode}");

        return is_string($url) && $url !== '' ? rtrim($url, '/') : null;
    }

    /** Store a new webhook secret (hash + ciphertext). The plain value is shown to the merchant once. */
    public function setWebhookSecret(#[SensitiveParameter] ?string $secret): void
    {
        $this->webhook_secret_hash = $secret === null ? null : hash('sha256', $secret);
        $this->webhook_secret_encrypted = $secret === null ? null : app(IntegrationCredentials::class)->encryptString($secret);
    }

    public function webhookSecret(): ?string
    {
        return $this->webhook_secret_encrypted === null ? null : app(IntegrationCredentials::class)->decryptString($this->webhook_secret_encrypted);
    }

    /** Constant-time check of a presented secret against the stored sha256. */
    public function webhookSecretMatches(#[SensitiveParameter] ?string $presented): bool
    {
        if ($presented === null || $presented === '' || $this->webhook_secret_hash === null) {
            return false;
        }

        return hash_equals($this->webhook_secret_hash, hash('sha256', $presented));
    }

    /** credentials_hint: "••••" + last 4 of the API key / client id / access token. Never the secret itself. */
    public static function hintFor(string $provider, #[SensitiveParameter] array $credentials): string
    {
        return IntegrationCredentials::hint((string) ($credentials[self::HINT_FIELD[$provider] ?? ''] ?? ''));
    }

    /** 32 random base62 characters (~190 bits); globally unique by index. */
    public static function newRouteKey(): string
    {
        return self::random(32);
    }

    /** 40 random base62 characters: the Steadfast bearer secret we issue (P5B-37). */
    public static function newWebhookSecret(): string
    {
        return self::random(40);
    }

    private static function random(int $length): string
    {
        $alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
        $out = '';
        for ($i = 0; $i < $length; $i++) {
            $out .= $alphabet[random_int(0, 61)];
        }

        return $out;
    }
}
