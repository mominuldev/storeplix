<?php

declare(strict_types=1);

namespace App\Domain\Admin\Tenants;

use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\Plan;
use App\Domain\Domains\Http\Resources\DomainPresenter;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Tenancy\Support\PlatformDb;
use Illuminate\Database\Query\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Pagination\LengthAwarePaginator;
use Illuminate\Support\Carbon;

/**
 * PHASE-8-1 §6.2 – §6.4 output shapes (openapi 1.9.0: AdminShopRef, AdminInvoiceSummary, AdminDomain) built from rows
 * read on the admin connection (P8-6), plus the admin JSON envelope (`Cache-Control: private, no-store`).
 */
final class AdminPresenter
{
    /** @param array<string, mixed> $body */
    public static function json(array $body, int $status = 200): JsonResponse
    {
        return new JsonResponse($body, $status, ['Cache-Control' => 'private, no-store']);
    }

    /**
     * @param  LengthAwarePaginator<int, mixed>  $page
     * @param  list<array<string, mixed>>  $data
     * @param  array<string, mixed>  $extraMeta
     */
    public static function paginated(LengthAwarePaginator $page, array $data, array $extraMeta = []): JsonResponse
    {
        return self::json(['data' => $data, 'meta' => [
            'current_page' => $page->currentPage(), 'per_page' => $page->perPage(), 'total' => $page->total(), 'last_page' => $page->lastPage(),
        ] + $extraMeta]);
    }

    public static function ts(mixed $value): ?string
    {
        if ($value === null || $value === '') {
            return null;
        }

        return ($value instanceof \DateTimeInterface ? Carbon::instance($value) : Carbon::parse((string) $value))->utc()->toIso8601ZuluString();
    }

    /**
     * AdminShopRef {id, name, slug} for each tenant id: the store's name and slug (one store per tenant), else the tenant's.
     *
     * @param  list<string>  $tenantIds
     * @return array<string, array{id: string, name: string, slug: string}>
     */
    public static function shopRefs(array $tenantIds): array
    {
        $tenantIds = array_values(array_unique(array_filter($tenantIds)));
        if ($tenantIds === []) {
            return [];
        }
        $db = PlatformDb::connection(); // cross-tenant: admin shop references
        $stores = $db->table('stores')->whereIn('tenant_id', $tenantIds)->get(['tenant_id', 'name', 'slug'])->keyBy('tenant_id');
        $out = [];
        foreach ($db->table('tenants')->whereIn('id', $tenantIds)->get(['id', 'name']) as $t) {
            $store = $stores->get($t->id);
            $out[(string) $t->id] = ['id' => (string) $t->id, 'name' => (string) ($store->name ?? $t->name), 'slug' => (string) ($store->slug ?? '')];
        }

        return $out;
    }

    /**
     * @param  object  $row  billing_invoices row (+ `plan_code`, `paid_provider`)
     * @param  array<string, array{id: string, name: string, slug: string}>  $shops
     * @return array<string, mixed> AdminInvoiceSummary
     */
    public static function invoiceSummary(object $row, array $shops): array
    {
        $tenantId = (string) $row->tenant_id;

        return [
            'id' => (string) $row->id,
            'number' => (string) $row->number,
            'tenant' => $shops[$tenantId] ?? ['id' => $tenantId, 'name' => '', 'slug' => ''],
            'kind' => (string) $row->kind,
            'status' => (string) $row->status,
            'plan_code' => (string) ($row->plan_code ?? Plan::FREE),
            'billing_interval' => (string) $row->interval,
            'total_amount' => (int) $row->total_amount,
            'currency' => 'BDT',
            'provider' => $row->paid_provider ?? null,
            'issued_at' => self::ts($row->issued_at),
            'due_at' => self::ts($row->due_at),
            'paid_at' => self::ts($row->paid_at),
        ];
    }

    /**
     * Invoice rows with `plan_code` and `paid_provider` (provider of the paying payment), on the admin connection.
     *
     * @return Builder
     */
    public static function invoiceQuery()
    {
        // cross-tenant: admin invoices
        return PlatformDb::connection()->table('billing_invoices as i')
            ->leftJoin('plans as p', 'p.id', '=', 'i.plan_id')
            ->leftJoin('billing_payments as bp', function ($join): void {
                $join->on('bp.id', '=', 'i.paid_payment_id')->on('bp.tenant_id', '=', 'i.tenant_id');
            })
            ->select(['i.id', 'i.tenant_id', 'i.number', 'i.kind', 'i.status', 'i.interval', 'i.total_amount', 'i.issued_at',
                'i.due_at', 'i.paid_at', 'p.code as plan_code', 'bp.provider as paid_provider']);
    }

    /**
     * @param  array<string, array{id: string, name: string, slug: string}>  $shops
     * @return array<string, mixed> AdminDomain
     */
    public static function domain(StoreDomain $d, array $shops): array
    {
        $tenantId = (string) $d->tenant_id;
        $records = is_array($d->last_check['records'] ?? null) ? $d->last_check['records'] : [];
        $observed = fn (string $purpose): ?string => is_array($records[$purpose] ?? null) ? (string) ($records[$purpose]['status'] ?? '') : null;
        $dns = match (true) {
            $d->isPlatform() => true,
            $observed('ownership') === null && $observed('routing') === null => null,
            default => $observed('ownership') === 'ok' && $observed('routing') === 'ok',
        };
        $ssl = match (DomainPresenter::sslStatus($d)) {
            'active' => true,
            'failed' => false,
            default => null,
        };

        return [
            'id' => $d->id,
            'hostname' => $d->hostname,
            'tenant' => $shops[$tenantId] ?? ['id' => $tenantId, 'name' => '', 'slug' => ''],
            'kind' => $d->type,
            'status' => $d->status,
            'failure_code' => $d->failure_code,
            'is_primary' => (bool) $d->is_primary,
            'dns_ok' => $dns,
            'ssl_ok' => $ssl,
            'last_checked_at' => self::ts($d->last_checked_at),
            'created_at' => self::ts($d->created_at),
        ];
    }

    /** BillingInvoice ids are ULIDs; anything else is an unknown id (404). */
    public static function isUlid(string $id): bool
    {
        return preg_match('/^[0-9A-Za-z]{26}$/', $id) === 1;
    }

    /** cross-tenant: admin invoice → owning tenant id (null = unknown). */
    public static function invoiceTenant(string $invoiceId): ?string
    {
        if (! self::isUlid($invoiceId)) {
            return null;
        }
        $tenant = BillingInvoice::withoutTenancy()->whereKey(strtolower($invoiceId))->value('tenant_id');

        return $tenant === null ? null : (string) $tenant;
    }
}
