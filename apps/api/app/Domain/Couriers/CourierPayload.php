<?php

declare(strict_types=1);

namespace App\Domain\Couriers;

use App\Domain\Payments\PayloadScrubber;

/**
 * Scrubs courier payloads before they reach shipments.raw, webhook_events.payload or a DTO's `raw` (S26): the
 * PayloadScrubber list (secrets, tokens, generic PII) plus the courier recipient fields. Values become "[redacted]".
 */
final class CourierPayload
{
    private const KEYS = [
        'recipient_name', 'recipient_phone', 'recipient_address', 'recipient_email', 'alternative_phone',
        'customer_address', 'customer_name', 'customer_phone', 'delivery_address', 'contact_number',
        'secondary_contact', 'api-key', 'secret-key', 'api-access-token', 'x-pathao-signature', 'client_id',
    ];

    /**
     * @param  array<array-key, mixed>  $payload
     * @return array<array-key, mixed>
     */
    public static function scrub(array $payload): array
    {
        return PayloadScrubber::scrub(self::own($payload));
    }

    /** @param array<array-key, mixed> $payload */
    private static function own(array $payload): array
    {
        $out = [];
        foreach ($payload as $key => $value) {
            if (is_string($key) && in_array(strtolower($key), self::KEYS, true)) {
                $out[$key] = PayloadScrubber::REDACTED;

                continue;
            }
            $out[$key] = is_array($value) ? self::own($value) : $value;
        }

        return $out;
    }
}
