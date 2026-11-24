<?php

declare(strict_types=1);

namespace App\Domain\Admin\Settings\Http;

use App\Domain\Admin\Settings\Http\Requests\UpdateSecuritySettingsRequest;
use App\Domain\Admin\Settings\PlatformSettings;
use App\Domain\Identity\Models\User;
use App\Domain\Identity\Support\CredentialVerifier;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Http\JsonResponse;

/**
 * Amendment A1-4: `GET|PATCH /admin/settings/security` (`manage_settings`). The change needs the caller's current
 * password; turning staff two-step sign-in off outside `local` is audited with `meta.risk: high` (A1-5).
 */
class PlatformSettingsController
{
    public function __construct(
        private readonly PlatformSettings $settings,
        private readonly AuditLogger $audit,
    ) {}

    public function showSecurity(): JsonResponse
    {
        return new JsonResponse(['data' => $this->settings->security()]);
    }

    public function updateSecurity(UpdateSecuritySettingsRequest $request): JsonResponse
    {
        /** @var User $user */
        $user = $request->user();
        if (! CredentialVerifier::check($user, (string) $request->validated('current_password'))) {
            throw new ApiException(422, 'invalid_password', 'That password is not correct.');
        }

        $from = $this->settings->staffTwoFactorRequired();
        $to = $request->boolean('staff_two_factor_required');
        $this->settings->set(PlatformSettings::STAFF_TWO_FACTOR_REQUIRED, $to, $user);

        $meta = ['key' => PlatformSettings::STAFF_TWO_FACTOR_REQUIRED, 'from' => $from, 'to' => $to];
        if (! $to && ! app()->environment('local')) {
            $meta['risk'] = 'high';
        }
        $this->audit->log('admin.settings_updated', meta: $meta, actor: $user, tenantId: false, platform: true);

        return new JsonResponse(['data' => $this->settings->security()]);
    }
}
