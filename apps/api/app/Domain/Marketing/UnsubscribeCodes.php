<?php

declare(strict_types=1);

namespace App\Domain\Marketing;

use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Str;

/**
 * Unsubscribe codes (P85-6): 10 base62 characters (≈ 59 bits), random per recipient, stored as sha256 only.
 *
 * Test sends (P85-26) get a code too. They have no recipient row; their sha256 lives in the `campaign.test_sent` audit
 * row (`meta.code_hash`, with the channel, the masked address and the store id), which is durable, so test codes
 * never expire either (§4.2, §9.1). The page then says "This was a test message" and nothing ever changes for it.
 * PHASE-8-6 §8: automation test messages (`automation.test_sent`) resolve the same way.
 */
final class UnsubscribeCodes
{
    public const PATTERN = '/^[A-Za-z0-9]{10}$/';

    public static function generate(): string
    {
        return Str::random(10);
    }

    public static function hash(string $code): string
    {
        return hash('sha256', $code);
    }

    public static function valid(string $code): bool
    {
        return preg_match(self::PATTERN, $code) === 1;
    }

    /** A test code of this store (inside the tenant context). @return array{channel: string, to_masked: string}|null */
    public static function test(string $code, string $storeId): ?array
    {
        $row = AuditLog::query()->where('tenant_id', app(TenantContext::class)->requireId())
            ->whereIn('action', ['campaign.test_sent', 'automation.test_sent'])->where('meta->code_hash', self::hash($code))->first(['meta']);
        $meta = (array) ($row?->meta ?? []);
        if ($row === null || ($meta['store_id'] ?? null) !== $storeId) {
            return null;
        }

        return ['channel' => (string) ($meta['channel'] ?? 'sms'), 'to_masked' => (string) ($meta['to_masked'] ?? '')];
    }
}
