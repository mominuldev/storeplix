<?php

declare(strict_types=1);

namespace App\Domain\Developer\Webhooks;

use App\Domain\Developer\Webhooks\Models\WebhookSecret;
use App\Domain\Integrations\IntegrationCredentials;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;

/**
 * The store signing secret (P84-7, Q132, S109): `whsec_` + 32 base62, IntegrationCredentials ciphertext at rest,
 * created lazily (first endpoint or first read). Rotate keeps the previous secret signing for 24 h (P84-8).
 */
final class WebhookSecrets
{
    public const PREFIX = 'whsec_';

    public const OVERLAP_HOURS = 24;

    public function __construct(
        private readonly IntegrationCredentials $crypto,
        private readonly AuditLogger $audit,
    ) {}

    public function ensure(Store $store): WebhookSecret
    {
        $existing = WebhookSecret::query()->where('store_id', $store->id)->first();
        if ($existing !== null) {
            return $existing;
        }

        try {
            return DB::transaction(function () use ($store) {
                $plain = self::generate();
                $row = new WebhookSecret;
                $row->store_id = $store->id;
                $row->secret_encrypted = $this->crypto->encryptString($plain);
                $row->last_four = substr($plain, -4);
                $row->save();

                return $row;
            });
        } catch (UniqueConstraintViolationException) {
            return WebhookSecret::query()->where('store_id', $store->id)->firstOrFail();
        }
    }

    /** @return array{0: WebhookSecret, 1: string} */
    public function reveal(Store $store): array
    {
        $row = $this->ensure($store);
        $this->audit->log('webhook_secret.revealed', $row, ['store_id' => $store->id]);

        return [$row, $this->crypto->decryptString($row->secret_encrypted)];
    }

    /** @return array{0: WebhookSecret, 1: string} the row and the new plain secret (shown once) */
    public function rotate(Store $store): array
    {
        $this->ensure($store);

        return DB::transaction(function () use ($store) {
            /** @var WebhookSecret $row */
            $row = WebhookSecret::query()->where('store_id', $store->id)->lockForUpdate()->firstOrFail();
            $plain = self::generate();
            $row->previous_secret_encrypted = $row->secret_encrypted;
            $row->previous_expires_at = now()->addHours(self::OVERLAP_HOURS);
            $row->secret_encrypted = $this->crypto->encryptString($plain);
            $row->last_four = substr($plain, -4);
            $row->rotated_at = now();
            $row->save();
            $this->audit->log('webhook_secret.rotated', $row, ['store_id' => $store->id]);

            return [$row, $plain];
        });
    }

    /** @return list<string> plain secrets that sign now: current, then the previous one while it overlaps */
    public function signing(string $storeId): array
    {
        $row = WebhookSecret::query()->where('store_id', $storeId)->first();
        if ($row === null) {
            $store = Store::query()->findOrFail($storeId);
            $row = $this->ensure($store);
        }
        $secrets = [$this->crypto->decryptString($row->secret_encrypted)];
        if ($row->previous_secret_encrypted !== null && $row->previous_expires_at?->isFuture()) {
            $secrets[] = $this->crypto->decryptString($row->previous_secret_encrypted);
        }

        return $secrets;
    }

    /** @return array<string, mixed> WebhookSecret */
    public static function present(WebhookSecret $row, ?string $plain = null): array
    {
        $overlap = $row->previous_secret_encrypted !== null && $row->previous_expires_at?->isFuture();

        return [
            'last_four' => $row->last_four,
            'masked' => self::PREFIX.'••••'.$row->last_four,
            'rotated_at' => $row->rotated_at?->toIso8601ZuluString(),
            'previous_expires_at' => $overlap ? $row->previous_expires_at?->toIso8601ZuluString() : null,
        ] + ($plain !== null ? ['secret' => $plain] : []);
    }

    public static function generate(): string
    {
        $alphabet = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
        $out = '';
        for ($i = 0; $i < 32; $i++) {
            $out .= $alphabet[random_int(0, 61)];
        }

        return self::PREFIX.$out;
    }
}
