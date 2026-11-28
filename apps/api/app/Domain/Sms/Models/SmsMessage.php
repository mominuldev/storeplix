<?php

namespace App\Domain\Sms\Models;

use App\Domain\Sms\SmsResult;
use App\Domain\Sms\SmsSendFailed;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Outbound SMS log. tenant_id is nullable (auth OTPs are account-level), so this is a platform model; never stores OTP
 * or checkout-code plaintext (template name only; `body_preview` null for codes, PHASE-8-9A P89A-21).
 *
 * PHASE-8-9A §3.2: the shop's SMS log. `store_id` (null for account codes), `kind`, `parts`, `charged_from`
 * (allowance | credits, null when skipped / pre-8.9a), `credits_charged`, `sender_id` (caller ID used, null = shared),
 * `body_preview` (≤ 160, links as [link]), `error_code` (provider_error | no_credits), `sent_at`, `reference_type/id`.
 * Every tenant listing filters tenant_id, store_id and `purpose NOT LIKE 'otp\_%'` explicitly (P89A-20).
 *
 * PHASE-8-9B §3.2: platform SMS (`otp_*`, `platform_*`) always have tenant_id NULL (+ merchant_tenant_id), so no shop
 * ever lists them; `error_code` gains provider_unavailable / provider_timeout / provider_auth / no_route (merchant
 * outputs map them to provider_error). A SENT row with an error_code went out through the failover after the first
 * provider failed (P89B-27 "failed over", staff only).
 *
 * @property string $id
 * @property string|null $tenant_id
 * @property string|null $store_id
 * @property string $to
 * @property string $purpose
 * @property string $template
 * @property string|null $provider_message_id
 * @property string $status queued|sent|failed|skipped
 * @property string|null $error
 * @property string|null $kind
 * @property int|null $parts
 * @property string|null $charged_from
 * @property int $credits_charged
 * @property string|null $sender_id
 * @property string|null $body_preview
 * @property string|null $error_code
 * @property Carbon|null $sent_at
 * @property string|null $reference_type
 * @property string|null $reference_id
 * @property string|null $provider_id PHASE-8-9B: the sms_providers row that carried it (null = environment / not sent)
 * @property string|null $merchant_tenant_id PHASE-8-9B: platform rows only — the merchant the SMS was about
 * @property string|null $platform_type PHASE-8-9B: PlatformSmsType (null for shop rows)
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class SmsMessage extends Model
{
    use HasUlids;

    public const QUEUED = 'queued';

    public const SENT = 'sent';

    public const FAILED = 'failed';

    public const SKIPPED = 'skipped';

    public const STATUSES = [self::QUEUED, self::SENT, self::FAILED, self::SKIPPED];

    public const ALLOWANCE = 'allowance';

    public const CREDITS = 'credits';

    public const NO_CREDITS = 'no_credits';

    public const PROVIDER_ERROR = 'provider_error';

    protected $fillable = [
        'tenant_id', 'store_id', 'to', 'purpose', 'template', 'provider_message_id', 'status', 'error', 'kind', 'parts',
        'charged_from', 'credits_charged', 'sender_id', 'body_preview', 'error_code', 'sent_at', 'reference_type', 'reference_id',
        'provider_id', 'merchant_tenant_id', 'platform_type',
    ];

    protected $attributes = ['credits_charged' => 0];

    protected function casts(): array
    {
        return ['parts' => 'integer', 'credits_charged' => 'integer', 'sent_at' => 'datetime'];
    }

    /** Marks a queued row sent (provider accepted). PHASE-8-9B: records the carrying provider and a failover. */
    public function markSent(?string $providerMessageId, ?SmsResult $result = null): void
    {
        $this->update(['status' => self::SENT, 'provider_message_id' => $providerMessageId, 'sent_at' => now(),
            'provider_id' => $result?->provider_id, 'error_code' => $result?->failover_error_code,
            'error' => $result?->failover_detail !== null ? mb_substr($result->failover_detail, 0, 250) : null]);
    }

    /**
     * Marks a row failed; the raw provider text stays internal (`error`), merchants only ever see `provider_error`
     * (PHASE-8-9B: the row keeps our specific code and the provider that failed).
     */
    public function markFailed(?string $error, ?SmsSendFailed $failure = null): void
    {
        $this->update(['status' => self::FAILED, 'error' => $error !== null ? mb_substr($error, 0, 250) : null,
            'error_code' => $failure?->errorCode() ?? self::PROVIDER_ERROR, 'provider_id' => $failure?->providerId]);
    }
}
