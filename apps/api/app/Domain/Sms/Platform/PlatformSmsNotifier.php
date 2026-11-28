<?php

declare(strict_types=1);

namespace App\Domain\Sms\Platform;

use App\Domain\Identity\Models\User;
use App\Domain\Shared\Support\Phone;
use App\Domain\Sms\Jobs\SendPlatformSms;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\SmsPreview;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * PHASE-8-9B §5 (P89B-16): `send(type, user, vars, about)` — checks the type's switch and the user's VERIFIED phone (no
 * verified phone → no row, log `platform_sms.skipped_unverified`), renders the bn/en template in the shop's SMS language,
 * writes the `sms_messages` row (`tenant_id` NULL, `merchant_tenant_id`, purpose, `platform_type`, `parts`, preview) and
 * dispatches SendPlatformSms after commit. Never throws into the caller's flow (billing must keep working).
 */
class PlatformSmsNotifier
{
    public function __construct(private readonly TenantContext $context) {}

    /** @param array<string, string|int|null> $vars */
    public function send(PlatformSmsType $type, User $to, array $vars, ?string $aboutTenantId = null, ?string $language = null): ?SmsMessage
    {
        try {
            if (! $type->editable() || ! PlatformSmsTemplates::enabled($type)) {
                return null;
            }
            $msisdn = $to->phone_verified_at !== null ? Phone::bdMsisdn($to->phone) : null;
            if ($msisdn === null) {
                Log::info('platform_sms.skipped_unverified', ['type' => $type->value, 'user_id' => $to->id]);

                return null;
            }
            $language ??= $aboutTenantId !== null ? $this->languageOf($aboutTenantId) : 'bn';
            $text = PlatformSmsTemplates::render(PlatformSmsTemplates::body($type, $language), $vars + ['link' => PlatformSmsTemplates::planLink()]);

            return $this->queue($type, $msisdn, $text, $language, $aboutTenantId);
        } catch (Throwable $e) {
            Log::warning('platform_sms.send_failed', ['type' => $type->value, 'error' => $e::class]);

            return null;
        }
    }

    /**
     * §5 welcome: after the user's FIRST successful phone verification (claim on `users.welcome_sms_at`, once only).
     * `{store_name}` = the user's first owned store, else "your shop"; language bn.
     */
    public function welcome(User $user): ?SmsMessage
    {
        try {
            $claimed = DB::table('users')->where('id', $user->id)->whereNull('welcome_sms_at')->update(['welcome_sms_at' => now()]);
            if ($claimed !== 1) {
                return null;
            }
            $tenantId = TenantUser::query()->where('user_id', $user->id)->where('role', TenantUser::ROLE_OWNER)->orderBy('created_at')->value('tenant_id');
            $store = $tenantId !== null ? $this->context->run((string) $tenantId, fn () => Store::query()->orderBy('created_at')->value('name')) : null;

            return $this->send(PlatformSmsType::Welcome, $user->refresh(), [
                'merchant_name' => $user->name, 'store_name' => is_string($store) && $store !== '' ? $store : 'your shop',
            ], $tenantId !== null ? (string) $tenantId : null, 'bn');
        } catch (Throwable $e) {
            Log::warning('platform_sms.welcome_failed', ['error' => $e::class]);

            return null;
        }
    }

    /** Writes the queued row and dispatches the job after commit. */
    public function queue(PlatformSmsType $type, string $msisdn, string $text, string $language, ?string $aboutTenantId, string $purpose = ''): SmsMessage
    {
        $purpose = $purpose !== '' ? $purpose : $type->purpose();
        $message = SmsMessage::query()->create([
            'tenant_id' => null, 'merchant_tenant_id' => $aboutTenantId, 'to' => $msisdn, 'purpose' => $purpose,
            'template' => 'platform:'.$type->value.'.'.$language, 'status' => SmsMessage::QUEUED, 'platform_type' => $type->value,
            'parts' => PlatformSmsTemplates::count($text)['parts'], 'body_preview' => SmsPreview::of($purpose, $text),
        ]);
        SendPlatformSms::dispatch($message->id, $text, $type->value)->afterCommit();

        return $message;
    }

    private function languageOf(string $tenantId): string
    {
        $value = $this->context->id() === $tenantId
            ? StoreSetting::query()->value('sms_language')
            : $this->context->run($tenantId, fn () => StoreSetting::query()->value('sms_language'));

        return $value === 'en' ? 'en' : 'bn';
    }
}
