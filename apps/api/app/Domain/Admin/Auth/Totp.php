<?php

declare(strict_types=1);

namespace App\Domain\Admin\Auth;

use chillerlan\QRCode\QRCode;
use chillerlan\QRCode\QROptions;
use PragmaRX\Google2FA\Google2FA;

/**
 * PHASE-8-1 P8-4: RFC 6238 TOTP (SHA-1, 6 digits, 30 s, ±1 step). Replay protection: a code is accepted only for a
 * step newer than `users.totp_last_step`, so a used code (and any older one) is refused for the rest of its window.
 * The QR is rendered as SVG by chillerlan/php-qrcode (already a dependency for documents, so no second QR library).
 */
final class Totp
{
    public const ISSUER = 'Store Plix Admin';

    private readonly Google2FA $engine;

    public function __construct()
    {
        $this->engine = new Google2FA;
        $this->engine->setWindow(1);
    }

    public function generateSecret(): string
    {
        return $this->engine->generateSecretKey(32);
    }

    /**
     * @return int|null the matched step (store it in `totp_last_step`), or null for a wrong or replayed code
     */
    public function verify(string $secret, string $code, ?int $lastStep): ?int
    {
        if (preg_match('/^\d{6}$/', $code) !== 1) {
            return null;
        }
        // Clock from Carbon (testable with travel()); old step 0 = "never used" so the engine returns the matched step.
        $step = $this->engine->verifyKeyNewer($secret, $code, $lastStep ?? 0, 1, self::step());

        return is_int($step) ? $step : null;
    }

    /** Current code for a secret (tests). */
    public function now(string $secret): string
    {
        return $this->engine->oathTotp($secret, self::step());
    }

    public static function step(): int
    {
        return intdiv(now()->getTimestamp(), 30);
    }

    public function otpauthUri(string $email, string $secret): string
    {
        return $this->engine->getQRCodeUrl(self::ISSUER, $email, $secret);
    }

    /** Raw `<svg>` markup (no XML header); the SPA renders it as an image data URI. */
    public function qrSvg(string $otpauthUri): string
    {
        $options = new QROptions(['outputType' => 'svg', 'outputBase64' => false, 'addQuietzone' => true, 'svgAddXmlHeader' => false]);

        return (new QRCode($options))->render($otpauthUri);
    }
}
