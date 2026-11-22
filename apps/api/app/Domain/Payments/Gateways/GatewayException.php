<?php

declare(strict_types=1);

namespace App\Domain\Payments\Gateways;

use RuntimeException;

/**
 * A gateway call that could not produce a report. `errorCode` is an API error code (§4.0): credentials_invalid (422),
 * provider_unavailable (502: timeout, 5xx, transport error, 2-calls/hour grant guard), gateway_refund_rejected (422),
 * gateway_not_connected (422). The message is safe to log (ids and status codes only, never secrets).
 */
class GatewayException extends RuntimeException
{
    public const CREDENTIALS_INVALID = 'credentials_invalid';

    public const PROVIDER_UNAVAILABLE = 'provider_unavailable';

    public const REFUND_REJECTED = 'gateway_refund_rejected';

    public const NOT_CONNECTED = 'gateway_not_connected';

    public function __construct(public readonly string $errorCode, string $message = '', public readonly ?string $field = null)
    {
        parent::__construct($message !== '' ? $message : $errorCode);
    }

    public function httpStatus(): int
    {
        return $this->errorCode === self::PROVIDER_UNAVAILABLE ? 502 : 422;
    }
}
