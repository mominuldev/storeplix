<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Drivers;

use RuntimeException;

/**
 * A courier call that could not produce a result (PHASE-5B §4.0). `errorCode`:
 * - credentials_invalid (422): the courier rejected the credentials (connect/test/token);
 * - provider_unavailable (502): timeout, transport error, 5xx, unreadable answer. On book() this means the outcome is
 *   UNKNOWN: the parcel may exist. Keep the shipment `booking` and reconcile with findByInvoice() (P5B-33);
 * - courier_rejected (422): the courier refused the booking; `message` is sanitised (no PII, ≤ 255 chars) and
 *   `field` names our input field when known (`weight_grams`, `recipient_phone`, `area`, ...);
 * - courier_cancel_unsupported (409): the driver has no cancel API;
 * - webhook_unauthorized (401): missing/wrong webhook secret (nothing may be stored);
 * - gateway_not_connected (422): base URL for the mode is not configured.
 * The message is safe to log: ids and status codes only, never secrets or recipient data.
 */
class CourierException extends RuntimeException
{
    public const CREDENTIALS_INVALID = 'credentials_invalid';

    public const PROVIDER_UNAVAILABLE = 'provider_unavailable';

    public const COURIER_REJECTED = 'courier_rejected';

    public const CANCEL_UNSUPPORTED = 'courier_cancel_unsupported';

    public const WEBHOOK_UNAUTHORIZED = 'webhook_unauthorized';

    public const NOT_CONNECTED = 'gateway_not_connected';

    public function __construct(public readonly string $errorCode, string $message = '', public readonly ?string $field = null)
    {
        parent::__construct($message !== '' ? $message : $errorCode);
    }

    public function httpStatus(): int
    {
        return match ($this->errorCode) {
            self::PROVIDER_UNAVAILABLE => 502,
            self::CANCEL_UNSUPPORTED => 409,
            self::WEBHOOK_UNAUTHORIZED => 401,
            default => 422,
        };
    }

    /** Courier messages go to merchants: strip tags/control chars, collapse whitespace, cap at 255 characters. */
    public static function sanitise(string $message): string
    {
        $clean = strip_tags($message);
        $clean = (string) preg_replace('/[\x00-\x1F\x7F]+/u', ' ', $clean);
        $clean = trim((string) preg_replace('/\s+/u', ' ', $clean));

        return mb_substr($clean !== '' ? $clean : 'The courier rejected the booking.', 0, 255);
    }
}
