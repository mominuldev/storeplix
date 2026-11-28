<?php

declare(strict_types=1);

namespace App\Domain\Payments\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Integrations\Casts\EncryptedCredentials;
use App\Domain\Integrations\IntegrationCredentials;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * A merchant-owned gateway account (P5B-10/11), one per store and provider. `credentials` is IntegrationCredentials
 * ciphertext (bkash {app_key, app_secret, username, password}; sslcommerz {store_id, store_passwd}; nagad {merchant_id,
 * merchant_number, merchant_private_key, pg_public_key} — PEM keys, PHASE-8-9D P89D-44), hidden from
 * every serialisation. Nothing is mass-assignable; route_key is never writable from input (S39).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $provider
 * @property string $mode
 * @property string $status
 * @property array<string, string> $credentials
 * @property string|null $credentials_hint
 * @property bool $enabled
 * @property bool $is_default
 * @property string $route_key
 * @property Carbon|null $verified_at
 * @property Carbon|null $last_checked_at
 * @property string|null $last_error_code
 * @property string|null $connected_by
 * @property Carbon|null $connected_at
 * @property int $revision
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read User|null $connectedBy
 * @property-read Store $store
 */
class PaymentGatewayAccount extends Model
{
    use BelongsToTenant, HasUlids;

    public const BKASH = 'bkash';

    public const SSLCOMMERZ = 'sslcommerz';

    public const NAGAD = 'nagad'; // PHASE-8-9D P89D-44

    public const PROVIDERS = [self::BKASH, self::SSLCOMMERZ, self::NAGAD];

    public const SANDBOX = 'sandbox';

    public const LIVE = 'live';

    public const MODES = [self::SANDBOX, self::LIVE];

    public const CONNECTED = 'connected';

    public const ERROR = 'error';

    public const DISCONNECTED = 'disconnected';

    /** Presented for providers without a row. */
    public const NOT_CONNECTED = 'not_connected';

    /** Credential fields per provider (ConnectGatewayInput) and their max lengths. */
    public const CREDENTIAL_FIELDS = [
        self::BKASH => ['app_key' => 64, 'app_secret' => 128, 'username' => 64, 'password' => 128],
        self::SSLCOMMERZ => ['store_id' => 64, 'store_passwd' => 128],
        self::NAGAD => ['merchant_id' => 32, 'merchant_number' => 16, 'merchant_private_key' => 8192, 'pg_public_key' => 4096],
    ];

    /** The field whose last 4 characters form credentials_hint (P5B-10: app key / store id). */
    public const HINT_FIELD = [self::BKASH => 'app_key', self::SSLCOMMERZ => 'store_id', self::NAGAD => 'merchant_id'];

    protected $fillable = [];

    protected $hidden = ['credentials', 'route_key'];

    protected $attributes = ['enabled' => false, 'is_default' => false, 'revision' => 1];

    protected function casts(): array
    {
        return [
            'credentials' => EncryptedCredentials::class,
            'enabled' => 'boolean',
            'is_default' => 'boolean',
            'verified_at' => 'datetime',
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

    public function isConnected(): bool
    {
        return $this->status === self::CONNECTED;
    }

    /** Connected and enabled for checkout: a payment method (P5B-12). */
    public function isUsable(): bool
    {
        return $this->isConnected() && $this->enabled;
    }

    /** Provider base URL for this account's mode, from config only (S27). Null when not configured (bKash live). */
    public function baseUrl(): ?string
    {
        return self::baseUrlFor($this->provider, $this->mode);
    }

    public static function baseUrlFor(string $provider, string $mode): ?string
    {
        $url = config("payments.providers.{$provider}.base_urls.{$mode}");

        return is_string($url) && $url !== '' ? rtrim($url, '/') : null;
    }

    /**
     * P5B-11: a test charge of this account was verified as paid. Sets verified_at (and last_checked_at) without a
     * revision bump (it isn't a merchant edit). Called by PaymentService when a `purpose: test` payment succeeds.
     */
    public function markVerified(?Carbon $at = null): void
    {
        $at ??= Carbon::now();
        $this->forceFill(['verified_at' => $at, 'last_checked_at' => $at])->save();
    }

    /** credentials_hint: "••••" + last 4 of the app key (bKash) / store id (SSLCommerz). Never the secret itself. */
    public static function hintFor(string $provider, array $credentials): string
    {
        return IntegrationCredentials::hint((string) ($credentials[self::HINT_FIELD[$provider] ?? ''] ?? ''));
    }

    /** 32 random base62 characters (~190 bits); globally unique by index (P5B-19). */
    public static function newRouteKey(): string
    {
        $alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
        $key = '';
        for ($i = 0; $i < 32; $i++) {
            $key .= $alphabet[random_int(0, 61)];
        }

        return $key;
    }
}
