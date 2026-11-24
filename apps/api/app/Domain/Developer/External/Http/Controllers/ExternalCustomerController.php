<?php

declare(strict_types=1);

namespace App\Domain\Developer\External\Http\Controllers;

use App\Domain\Customers\Http\Controllers\CustomerController;
use App\Domain\Customers\Http\Resources\CustomerPresenter;
use App\Domain\Customers\Models\Customer;
use App\Domain\Stores\Models\Store;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/** PHASE-8-4 §3 external customers (read only, Q128): the merchant list (`q` = phone / email / name search) and detail. */
class ExternalCustomerController
{
    use ExternalLists;

    /** Merchant list (`q`, filters, `CustomerListMeta`); `filter[updated_since]` pages by `updated_at` ascending. */
    public function index(Request $request, Store $store): JsonResponse
    {
        $merchant = fn (Request $r) => app(CustomerController::class)->index($r, $store);
        $since = self::updatedSince($request);
        if ($since === null) {
            return $merchant($request);
        }
        $request->validate(['page' => ['sometimes', 'integer', 'min:1'], 'per_page' => ['sometimes', 'integer', 'min:1', 'max:100']]);
        $meta = self::metaOf(self::merchantList($request, ['updated_since'], $merchant, metaOnly: true));

        $filter = array_diff_key((array) $request->query('filter', []), ['updated_since' => true]);
        $page = CustomerController::filtered($store, $filter, trim((string) $request->query('q', '')))
            ->where('customers.updated_at', '>=', $since)
            ->orderBy('customers.updated_at')->orderBy('customers.id')
            ->with('createdBy')->withCount('notes')
            ->paginate((int) $request->query('per_page', 25));

        return self::page($page, $page->getCollection()
            ->map(fn (Customer $c) => CustomerPresenter::customer($c, $store->currency, (int) $c->notes_count))->all(), $meta);
    }

    public function show(Request $request, Store $store, Customer $customer): JsonResponse
    {
        return app(CustomerController::class)->show($request, $store, $customer);
    }
}
