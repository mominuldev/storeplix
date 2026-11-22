<?php

declare(strict_types=1);

namespace App\Domain\Tenancy\Support;

use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Orders\Models\Payment;
use App\Domain\Payments\Models\PaymentGatewayAccount;
use App\Domain\Tenancy\Database\RlsSession;
use Illuminate\Support\Facades\DB;

/**
 * Pre-tenant lookups for the public payment paths (PHASE-5B-CONTRACT §2.4 B12, B13): ids only, the caller then works
 * inside TenantContext::run(). With RLS on they call the SECURITY DEFINER functions (`sp_payment_owner`,
 * `sp_route_key_owner`); with RLS off (sqlite, dev, the owner-run api-postgres job) the pre-5b app-level opt-out.
 */
class IntegrationLookup
{
    public function __construct(private readonly RlsSession $rls) {}

    /** B13: signed payment-return URL → owning tenant/store. @return array{tenant_id: string, store_id: string}|null */
    public function paymentOwner(string $paymentId): ?array
    {
        $paymentId = strtolower($paymentId);
        if (preg_match('/^[0-9a-hjkmnp-tv-z]{26}$/', $paymentId) !== 1) {
            return null;
        }
        if ($this->rls->enabled()) {
            $row = DB::selectOne('select tenant_id, store_id from sp_payment_owner(?)', [$paymentId]);

            return $row === null ? null : ['tenant_id' => (string) $row->tenant_id, 'store_id' => (string) $row->store_id];
        }
        $row = Payment::withoutTenancy()->whereKey($paymentId)->first(['tenant_id', 'store_id']);

        return $row === null ? null : ['tenant_id' => (string) $row->tenant_id, 'store_id' => (string) $row->store_id];
    }

    /**
     * B12: webhook route key → owning tenant/store/account (gateway accounts; 5b-3 extends the definer function to
     * courier accounts). @return array{tenant_id: string, store_id: string, account_id: string}|null
     */
    public function routeKeyOwner(string $provider, string $routeKey): ?array
    {
        if (preg_match('/^[A-Za-z0-9]{32}$/', $routeKey) !== 1) {
            return null;
        }
        if ($this->rls->enabled()) {
            $row = DB::selectOne('select tenant_id, store_id, account_id from sp_route_key_owner(?, ?)', [$provider, $routeKey]);

            return $row === null ? null : ['tenant_id' => (string) $row->tenant_id, 'store_id' => (string) $row->store_id, 'account_id' => (string) $row->account_id];
        }
        $model = in_array($provider, CourierAccount::PROVIDERS, true) ? CourierAccount::class : PaymentGatewayAccount::class;
        $row = $model::withoutTenancy()->where('route_key', $routeKey)->where('provider', $provider)->first(['id', 'tenant_id', 'store_id']);

        return $row === null ? null : ['tenant_id' => (string) $row->tenant_id, 'store_id' => (string) $row->store_id, 'account_id' => (string) $row->id];
    }
}
