<?php

declare(strict_types=1);

namespace App\Domain\Admin\Search\Http;

use App\Domain\Admin\Tenants\AdminPresenter;
use App\Domain\Admin\Tenants\TenantDirectory;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Stores\Services\HostNormalizer;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * PHASE-8-1 P8-17 `GET /admin/search?q=` (≥ 2 chars): up to 5 tenants, 5 domains, 5 invoices, on the admin connection.
 * Exact: ULID, invoice number (`SP-…`), hostname. Prefix / contains: shop name, store slug, owner e-mail, owner phone
 * (digits only, `+88` stripped).
 */
class AdminSearchController
{
    public const LIMIT = 5;

    public function __invoke(Request $request): JsonResponse
    {
        $q = trim((string) $request->validate(['q' => ['required', 'string', 'min:2', 'max:120']])['q']);
        $term = str_replace(['%', '_'], '', mb_strtolower($q));
        $ulid = AdminPresenter::isUlid($q) ? strtolower($q) : null;
        $host = HostNormalizer::normalize($q);

        // Tenants: the merchants-list matching (name, slug, owner e-mail/phone, hostname, ULID).
        $tenantQuery = TenantDirectory::query([]);
        TenantDirectory::search($tenantQuery, $q);
        $tenantIds = $tenantQuery->orderByDesc('t.created_at')->limit(self::LIMIT)->pluck('t.id')->map(fn ($id) => (string) $id)->unique()->values()->all();

        // cross-tenant: admin global search (domains)
        $domains = StoreDomain::withoutTenancy()->where(function (Builder $w) use ($ulid, $host, $term): void {
            if ($ulid !== null) {
                $w->orWhere('id', $ulid);
            }
            if ($host !== null) {
                $w->orWhere('hostname', $host);
            }
            if ($term !== '' && strlen($term) >= 3) {
                $w->orWhereLike('hostname', "{$term}%");
            }
        })->orderByRaw('case when hostname = ? then 0 else 1 end', [$host ?? ''])->orderBy('hostname')->limit(self::LIMIT)->get();

        $invoices = AdminPresenter::invoiceQuery()->where(function ($w) use ($ulid, $q): void {
            $w->where('i.number', strtoupper($q));
            if ($ulid !== null) {
                $w->orWhere('i.id', $ulid);
            }
            if (preg_match('/^sp-[\d-]{2,}$/i', $q) === 1) {
                $w->orWhere('i.number', 'like', strtoupper($q).'%');
            }
        })->orderByDesc('i.issued_at')->limit(self::LIMIT)->get();

        $shops = AdminPresenter::shopRefs(array_merge(
            $domains->pluck('tenant_id')->map(fn ($id) => (string) $id)->all(),
            $invoices->pluck('tenant_id')->map(fn ($id) => (string) $id)->all(),
        ));

        return AdminPresenter::json(['data' => [
            'tenants' => TenantDirectory::summaries($tenantIds),
            'domains' => $domains->map(fn (StoreDomain $d) => AdminPresenter::domain($d, $shops))->all(),
            'invoices' => $invoices->map(fn ($row) => AdminPresenter::invoiceSummary($row, $shops))->all(),
        ]]);
    }
}
