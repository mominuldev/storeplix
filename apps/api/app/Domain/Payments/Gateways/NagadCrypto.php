<?php

declare(strict_types=1);

namespace App\Domain\Payments\Gateways;

use SensitiveParameter;

/**
 * Nagad request crypto (PHASE-8-9D P89D-46; VERIFY against the Nagad sandbox): `sensitiveData` is RSA-encrypted
 * (PKCS#1 v1.5) with Nagad's PG public key; `signature` is SHA256withRSA over the same JSON with the merchant private
 * key; responses carry `sensitiveData` encrypted to the merchant (decrypted with the merchant private key) and a
 * signature by Nagad (verified with the PG public key). Keys are PEM (a bare base64 body as Nagad hands it out is
 * wrapped). Nothing here logs or returns key material.
 */
final class NagadCrypto
{
    public const MIN_BITS = 2048;

    /** Normalises a pasted key to PEM. $kind: 'PRIVATE KEY' | 'PUBLIC KEY'. Null when it doesn't look like a key. */
    public static function pem(#[SensitiveParameter] string $raw, string $kind): ?string
    {
        $raw = trim(str_replace("\r", '', $raw));
        if ($raw === '') {
            return null;
        }
        if (str_contains($raw, '-----BEGIN')) {
            return $raw."\n";
        }
        $body = preg_replace('/\s+/', '', $raw) ?? '';
        if ($body === '' || preg_match('#^[A-Za-z0-9+/=]+$#', $body) !== 1) {
            return null;
        }

        return "-----BEGIN {$kind}-----\n".chunk_split($body, 64, "\n")."-----END {$kind}-----\n";
    }

    /**
     * §9.2: both keys parse, are RSA ≥ 2048 bits, and the private key decrypts a self-test encrypted to its own public
     * half. Returns the failing field or null.
     */
    public static function invalidField(#[SensitiveParameter] string $privatePem, #[SensitiveParameter] string $publicPem): ?string
    {
        $private = @openssl_pkey_get_private($privatePem);
        $details = $private !== false ? openssl_pkey_get_details($private) : false;
        if ($private === false || ! is_array($details) || ($details['type'] ?? null) !== OPENSSL_KEYTYPE_RSA || (int) ($details['bits'] ?? 0) < self::MIN_BITS) {
            return 'merchant_private_key';
        }
        $probe = random_bytes(32);
        $sealed = '';
        $opened = '';
        if (! @openssl_public_encrypt($probe, $sealed, (string) $details['key']) || ! @openssl_private_decrypt($sealed, $opened, $private) || ! hash_equals($probe, $opened)) {
            return 'merchant_private_key';
        }
        $public = @openssl_pkey_get_public($publicPem);
        $pub = $public !== false ? openssl_pkey_get_details($public) : false;
        if ($public === false || ! is_array($pub) || ($pub['type'] ?? null) !== OPENSSL_KEYTYPE_RSA || (int) ($pub['bits'] ?? 0) < self::MIN_BITS) {
            return 'pg_public_key';
        }

        return null;
    }

    /** base64(RSA-encrypt(data)) with a public key; null on failure. */
    public static function encrypt(string $data, #[SensitiveParameter] string $publicPem): ?string
    {
        $out = '';

        return @openssl_public_encrypt($data, $out, $publicPem, OPENSSL_PKCS1_PADDING) ? base64_encode($out) : null;
    }

    /** RSA-decrypt(base64) with a private key; null on failure. */
    public static function decrypt(string $base64, #[SensitiveParameter] string $privatePem): ?string
    {
        $raw = base64_decode($base64, true);
        $out = '';

        return $raw !== false && @openssl_private_decrypt($raw, $out, $privatePem, OPENSSL_PKCS1_PADDING) ? $out : null;
    }

    public static function sign(string $data, #[SensitiveParameter] string $privatePem): ?string
    {
        $sig = '';

        return @openssl_sign($data, $sig, $privatePem, OPENSSL_ALGO_SHA256) ? base64_encode($sig) : null;
    }

    public static function verify(string $data, string $base64Signature, #[SensitiveParameter] string $publicPem): bool
    {
        $sig = base64_decode($base64Signature, true);

        return $sig !== false && @openssl_verify($data, $sig, $publicPem, OPENSSL_ALGO_SHA256) === 1;
    }

    /** 40 hex characters (§9.3). */
    public static function challenge(): string
    {
        return bin2hex(random_bytes(20));
    }
}
