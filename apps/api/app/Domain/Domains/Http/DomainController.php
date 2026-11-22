<?php

declare(strict_types=1);

namespace App\Domain\Domains\Http;

use App\Domain\Domains\DomainService;
use App\Domain\Domains\Http\Requests\AddDomainRequest;
use App\Domain\Domains\Http\Resources\DomainPresenter;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreDomain;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\Gate;

/**
 * PHASE-6 §4.1 `/stores/{store}/domains…`. Reads O A S (Operate), writes O A (ManageDomains). `{domain}` resolves
 * through the store (scopeBindings): another store's or tenant's id → 404 `not_found`, never 403.
 */
class DomainController
{
    public function __construct(private readonly DomainService $domains) {}

    public function index(Store $store): JsonResponse
    {
        Gate::authorize('view', $store);
        Gate::authorize('viewAny', StoreDomain::class);
        $ctx = DomainPresenter::context($store);

        return new JsonResponse([
            'data' => array_map(fn (StoreDomain $d) => DomainPresenter::present($d, $ctx), DomainService::listFor($store)),
            'meta' => DomainPresenter::meta($store, $ctx),
        ]);
    }

    public function store(AddDomainRequest $request, Store $store): JsonResponse
    {
        Gate::authorize('view', $store);
        $domain = $this->domains->add($store, $request->hostname(), $request->user());

        return $this->one($store, $domain, 201);
    }

    public function show(Store $store, StoreDomain $domain): JsonResponse
    {
        Gate::authorize('view', $domain);

        return $this->one($store, $domain);
    }

    public function verify(Request $request, Store $store, StoreDomain $domain): JsonResponse
    {
        Gate::authorize('update', $domain);

        return $this->one($store, $this->domains->recheck($domain, $request->user()));
    }

    public function primary(Request $request, Store $store, StoreDomain $domain): JsonResponse
    {
        Gate::authorize('update', $domain);
        $rows = $this->domains->makePrimary($store, $domain, $request->user());
        $ctx = DomainPresenter::context($store);

        return new JsonResponse(['data' => array_map(fn (StoreDomain $d) => DomainPresenter::present($d, $ctx), $rows)]);
    }

    public function destroy(Request $request, Store $store, StoreDomain $domain): Response
    {
        Gate::authorize('delete', $domain);
        $this->domains->remove($domain, $request->user());

        return response()->noContent();
    }

    private function one(Store $store, StoreDomain $domain, int $status = 200): JsonResponse
    {
        return new JsonResponse(['data' => DomainPresenter::present($domain, DomainPresenter::context($store))], $status);
    }
}
