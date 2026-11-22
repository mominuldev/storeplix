<?php

declare(strict_types=1);

namespace App\Domain\Payments;

use App\Domain\Payments\Models\PaymentGatewayAccount;
use App\Domain\Shared\Http\UserRef;

/**
 * PaymentGatewayAccount (@storeplix/types, openapi v1.6.0), keys in contract order. An explicit allowlist: the
 * credentials, the route key and the raw provider data never appear (S26). Absent providers → `not_connected`.
 */
final class PaymentGatewayPresenter
{
    /** @return array<string, mixed> */
    public static function present(?PaymentGatewayAccount $a, string $provider): array
    {
        if ($a === null) {
            return [
                'provider' => $provider, 'status' => PaymentGatewayAccount::NOT_CONNECTED, 'mode' => null,
                'credentials_hint' => null, 'enabled' => false, 'is_default' => false, 'verified_at' => null,
                'last_checked_at' => null, 'last_error_code' => null, 'connected_by' => null, 'connected_at' => null,
                'revision' => 0,
            ];
        }

        return [
            'provider' => $a->provider,
            'status' => $a->status,
            'mode' => $a->mode,
            'credentials_hint' => $a->credentials_hint,
            'enabled' => $a->enabled,
            'is_default' => $a->is_default,
            'verified_at' => UserRef::iso($a->verified_at),
            'last_checked_at' => UserRef::iso($a->last_checked_at),
            'last_error_code' => $a->last_error_code,
            'connected_by' => UserRef::of($a->connectedBy),
            'connected_at' => UserRef::iso($a->connected_at),
            'revision' => $a->revision,
        ];
    }
}
