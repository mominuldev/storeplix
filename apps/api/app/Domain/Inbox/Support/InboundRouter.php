<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Support;

use App\Domain\Inbox\Models\InboxConversation;
use App\Domain\Inbox\Models\InboxSetting;
use App\Domain\Orders\Models\Order;
use App\Domain\Tenancy\Database\RlsSession;
use Illuminate\Support\Facades\DB;

/**
 * PHASE-8-8E §11.2 step 3: which shop an inbound email belongs to, before any tenant is known. Ids only; the caller
 * then works inside TenantContext::run(). With RLS on through the SECURITY DEFINER `sp_inbox_route`; with RLS off
 * through the explicit tenancy opt-out (cross-tenant: inbound email routing).
 */
final class InboundRouter
{
    public function __construct(private readonly RlsSession $rls) {}

    /** @return array{tenant_id: string, store_id: string, target_id: string}|null */
    public function route(string $kind, string $key): ?array
    {
        $key = strtolower($key);
        $valid = match ($kind) {
            ReplyAddress::STORE => preg_match('/^[a-z2-7]{12}$/', $key) === 1,
            ReplyAddress::CONVERSATION, ReplyAddress::ORDER => preg_match('/^[0-9a-hjkmnp-tv-z]{26}$/', $key) === 1,
            default => false,
        };
        if (! $valid) {
            return null;
        }
        if ($this->rls->enabled()) {
            $row = DB::selectOne('select tenant_id, store_id, target_id from sp_inbox_route(?, ?)', [$kind, $key]);

            return $row === null ? null : ['tenant_id' => trim((string) $row->tenant_id), 'store_id' => trim((string) $row->store_id), 'target_id' => trim((string) $row->target_id)];
        }
        // cross-tenant: inbound email routing (RLS off: sqlite, dev, the owner-run api-postgres job)
        $row = match ($kind) {
            ReplyAddress::STORE => InboxSetting::withoutTenancy()->where('email_key', $key)->first(['tenant_id', 'store_id', 'id']),
            ReplyAddress::CONVERSATION => InboxConversation::withoutTenancy()->whereKey($key)->first(['tenant_id', 'store_id', 'id']),
            default => Order::withoutTenancy()->whereKey($key)->first(['tenant_id', 'store_id', 'id']),
        };

        return $row === null ? null : ['tenant_id' => (string) $row->tenant_id, 'store_id' => (string) $row->store_id, 'target_id' => (string) $row->id];
    }
}
