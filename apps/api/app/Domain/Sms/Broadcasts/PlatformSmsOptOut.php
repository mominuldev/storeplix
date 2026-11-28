<?php

declare(strict_types=1);

namespace App\Domain\Sms\Broadcasts;

use App\Domain\Identity\Models\User;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Support\Phone;
use App\Domain\Sms\SmsPreview;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\Support\PlatformDb;

/**
 * PHASE-8-9B §7.6 (P89B-21, S229): per-USER opt-out of Store Plix promotional SMS. The public link code is looked up by
 * its sha256 only; GET never changes anything; POST is idempotent. The account switch acts on the signed-in user only.
 * Codes, billing and security SMS are never affected.
 */
final class PlatformSmsOptOut
{
    public const TEST_MASK = '01•••-•••000';

    public function __construct(private readonly AuditLogger $audit) {}

    /** @return array{status: string, phone_masked: string} */
    public function lookup(string $code): array
    {
        if ($code === BroadcastTexts::TEST_CODE) {
            return ['status' => 'subscribed', 'phone_masked' => self::TEST_MASK];
        }
        [$row, $user] = $this->find($code);

        return ['status' => $user?->platform_promo_sms_opted_out_at !== null ? 'opted_out' : 'subscribed', 'phone_masked' => SmsPreview::maskPhone($row->to ?? $user?->phone)];
    }

    /** @return array{status: string, phone_masked: string} */
    public function optOut(string $code): array
    {
        if ($code === BroadcastTexts::TEST_CODE) {
            return ['status' => 'subscribed', 'phone_masked' => self::TEST_MASK];
        }
        [$row, $user] = $this->find($code);
        if ($user !== null && $user->platform_promo_sms_opted_out_at === null) {
            $moved = User::query()->whereKey($user->id)->whereNull('platform_promo_sms_opted_out_at')
                ->update(['platform_promo_sms_opted_out_at' => now(), 'platform_promo_sms_opt_out_source' => 'link']);
            if ($moved === 1) {
                $this->audit->log('platform_sms.opted_out', $user, ['source' => 'link'], tenantId: false, system: true);
            }
        }

        return ['status' => 'opted_out', 'phone_masked' => SmsPreview::maskPhone($row->to ?? $user?->phone)];
    }

    /** @return array<string, mixed> SmsPreferences */
    public static function preferences(User $user): array
    {
        $user->refresh();
        $msisdn = Phone::bdMsisdn($user->phone);

        return [
            'promotional' => $user->platform_promo_sms_opted_out_at === null,
            'opted_out_at' => $user->platform_promo_sms_opted_out_at?->toIso8601ZuluString(),
            'source' => $user->platform_promo_sms_opted_out_at !== null ? $user->platform_promo_sms_opt_out_source : null,
            'phone_masked' => $msisdn !== null ? SmsPreview::maskPhone($msisdn) : null,
            'phone_verified' => $user->phone_verified_at !== null && $msisdn !== null,
        ];
    }

    /** @return array<string, mixed> SmsPreferences */
    public function update(User $user, bool $promotional): array
    {
        $query = User::query()->whereKey($user->id);
        $moved = $promotional
            ? $query->whereNotNull('platform_promo_sms_opted_out_at')->update(['platform_promo_sms_opted_out_at' => null, 'platform_promo_sms_opt_out_source' => null])
            : $query->whereNull('platform_promo_sms_opted_out_at')->update(['platform_promo_sms_opted_out_at' => now(), 'platform_promo_sms_opt_out_source' => 'account']);
        if ($moved === 1) {
            $this->audit->log($promotional ? 'platform_sms.opted_in' : 'platform_sms.opted_out', $user, ['source' => 'account'], $user, tenantId: false);
        }

        return self::preferences($user);
    }

    /** @return array{0: object, 1: User|null} (404 for an unknown code; one indexed lookup either way, S229) */
    private function find(string $code): array
    {
        $hash = hash('sha256', $code);
        // cross-tenant: platform SMS opt-out by code
        $row = PlatformDb::connection()->table('platform_sms_broadcast_recipients')->where('opt_out_code_hash', $hash)->first(['user_id', 'to']);
        if ($row === null || preg_match('/^[0-9A-Za-z]{10}$/', $code) !== 1) {
            throw new ApiException(404, 'not_found', 'This link is not valid.');
        }

        return [$row, $row->user_id !== null ? User::query()->find($row->user_id) : null];
    }
}
