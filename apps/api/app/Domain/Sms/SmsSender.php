<?php

declare(strict_types=1);

namespace App\Domain\Sms;

use App\Domain\Sms\Models\SmsSenderId;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\TenantCache;
use App\Domain\Tenancy\TenantContext;

/**
 * PHASE-8-9A §4.1 (P89A-17): the caller ID a store's SMS go out with — its `approved` masked sender ID, else null
 * (the platform caller ID with the "{shop}: " prefix). Cached per tenant (TenantCache key, 5 min) and flushed on
 * approve / revoke / supersede (forget()). Call inside the store's tenant context.
 */
final class SmsSender
{
    private const TTL = 300;

    public static function for(Store|string $store): ?string
    {
        $storeId = $store instanceof Store ? $store->id : $store;
        if (! app()->bound('cache') || ! app(TenantContext::class)->has()) {
            return null; // outside a tenant (pure renderers in unit tests): the shared sender
        }
        $value = app(TenantCache::class)->remember(self::key($storeId), self::TTL, fn () => (string) (SmsSenderId::query()
            ->where('store_id', $storeId)->where('status', SmsSenderId::APPROVED)->value('sender_id') ?? ''));

        return is_string($value) && $value !== '' ? $value : null;
    }

    public static function forget(string $storeId): void
    {
        app(TenantCache::class)->forget(self::key($storeId));
    }

    private static function key(string $storeId): string
    {
        return 'sms:sender:'.$storeId;
    }
}
