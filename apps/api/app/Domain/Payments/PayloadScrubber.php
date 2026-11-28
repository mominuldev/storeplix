<?php

declare(strict_types=1);

namespace App\Domain\Payments;

/**
 * Removes secrets, tokens, card data and shopper PII from provider payloads before they are stored in
 * `payments.raw` or `webhook_events.payload`, or put in a DTO's `raw` (S26). Keys are matched case-insensitively at
 * any depth; values are replaced by "[redacted]" so the shape stays debuggable. Business fields (status, amounts,
 * currency, ids, trx ids, risk level) are kept.
 */
final class PayloadScrubber
{
    public const REDACTED = '[redacted]';

    /** Exact keys (lower-case). */
    private const KEYS = [
        // credentials and tokens
        'app_key', 'app_secret', 'username', 'password', 'store_passwd', 'id_token', 'refresh_token', 'token',
        'access_token', 'authorization', 'x-app-key', 'secret', 'secret_key', 'api_key', 'client_secret', 'sessionkey',
        'signature', 'verify_sign', 'verify_sign_sha2', 'verify_key', 'signingcerturl', 'subscribeurl', 'unsubscribeurl',
        // Nagad (PHASE-8-9D): encrypted blobs, keys, challenge, wallet numbers
        'sensitivedata', 'merchant_private_key', 'pg_public_key', 'challenge', 'clientmobileno', 'merchantmobileno', 'accountnumber',
        // card / account data
        'card_no', 'card_number', 'card_issuer', 'card_issuer_country',
        'card_issuer_country_code', 'card_ref_id', 'bank_account', 'account_no', 'payer_account', 'customermsisdn',
        'msisdn', 'payerreference', 'payer_reference', 'mobile', 'wallet',
        // shopper PII
        'cus_name', 'cus_email', 'cus_add1', 'cus_add2', 'cus_city', 'cus_state', 'cus_postcode', 'cus_country',
        'cus_phone', 'cus_fax', 'ship_name', 'ship_add1', 'ship_add2', 'ship_city', 'ship_state', 'ship_postcode',
        'ship_country', 'customer_name', 'customer_phone', 'customer_email', 'email', 'phone', 'name', 'address',
    ];

    /**
     * @param  array<array-key, mixed>  $payload
     * @return array<array-key, mixed>
     */
    public static function scrub(array $payload): array
    {
        $out = [];
        foreach ($payload as $key => $value) {
            if (is_string($key) && in_array(strtolower($key), self::KEYS, true)) {
                $out[$key] = self::REDACTED;

                continue;
            }
            $out[$key] = is_array($value) ? self::scrub($value) : $value;
        }

        return $out;
    }
}
