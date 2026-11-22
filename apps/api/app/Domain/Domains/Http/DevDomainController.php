<?php

declare(strict_types=1);

namespace App\Domain\Domains\Http;

use App\Domain\Domains\Dns\FakeDnsResolver;
use App\Domain\Domains\DomainChecker;
use App\Domain\Domains\Http\Resources\DomainPresenter;
use App\Domain\Domains\Providers\FakeCustomHostnames;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreDomain;
use App\Domain\Tenancy\Support\DevDomainLookup;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Validation\Rule;

/**
 * TESTING-ONLY (PHASE-6 §4.4, API-CONVENTIONS §10.3): drives the fake DNS and provider for e2e. Registered only
 * outside production, 404 unless DOMAINS_FAKE=true. Each answers 200 `{data: StoreDomain}`, after a check with ?check=1.
 */
class DevDomainController
{
    public const PROVIDER_SSL = ['pending' => 'pending_validation', 'active' => 'active', 'failed' => 'validation_timed_out'];

    /** Fake A address of the CNAME target for the `flattened` routing (TEST-NET-1). */
    public const FLATTENED_IP = '192.0.2.10';

    public function __construct(
        private readonly DevDomainLookup $lookup,
        private readonly TenantContext $context,
        private readonly DomainChecker $checker,
    ) {}

    /** `{ownership: correct|wrong|missing, routing: correct|wrong|missing|flattened}` */
    public function dns(Request $request, string $domain): JsonResponse
    {
        $input = $request->validate([
            'ownership' => ['required', 'string', Rule::in(['correct', 'wrong', 'missing'])],
            'routing' => ['required', 'string', Rule::in(['correct', 'wrong', 'missing', 'flattened'])],
        ]);

        return $this->run($request, $domain, function (StoreDomain $row) use ($input) {
            $host = $row->hostname;
            $target = (string) config('domains.cname_target');
            FakeDnsResolver::set(config('domains.txt_prefix').'.'.$host, 'TXT', match ($input['ownership']) {
                'correct' => ['sp-verify='.$row->verification_token],
                'wrong' => ['sp-verify=not-the-right-token'],
                default => null,
            });
            FakeDnsResolver::set($host, 'CNAME', match ($input['routing']) {
                'correct' => [$target],
                'wrong' => ['elsewhere.example.net'],
                default => null,
            });
            FakeDnsResolver::set($host, 'A', $input['routing'] === 'flattened' ? [self::FLATTENED_IP] : null);
            FakeDnsResolver::set($host, 'AAAA', null);
            if ($input['routing'] === 'flattened') {
                FakeDnsResolver::set($target, 'A', [self::FLATTENED_IP]);
            }
        });
    }

    /** `{hostname_status: pending|active|blocked|moved, ssl_status: pending|active|failed}` */
    public function provider(Request $request, string $domain): JsonResponse
    {
        $input = $request->validate([
            'hostname_status' => ['required', 'string', Rule::in(['pending', 'active', 'blocked', 'moved'])],
            'ssl_status' => ['required', 'string', Rule::in(array_keys(self::PROVIDER_SSL))],
        ]);

        return $this->run($request, $domain, fn (StoreDomain $row) => FakeCustomHostnames::override(
            $row->hostname, $input['hostname_status'], self::PROVIDER_SSL[$input['ssl_status']],
        ));
    }

    /** `{hours: 1..400}`: moves the window/streak timestamps back and makes the row due now. */
    public function age(Request $request, string $domain): JsonResponse
    {
        $input = $request->validate(['hours' => ['required', 'integer', 'min:1', 'max:400']]);
        $hours = (int) $input['hours'];

        return $this->run($request, $domain, function (StoreDomain $row) use ($hours) {
            $set = ['next_check_at' => $row->next_check_at !== null ? now() : null];
            foreach (['verification_started_at', 'status_changed_at', 'first_failed_at', 'verified_at', 'unproven_since'] as $column) {
                if ($row->{$column} !== null) {
                    $set[$column] = $row->{$column}->copy()->subHours($hours);
                }
            }
            // Bookkeeping-style update (no model events): not a routing change.
            DB::table('store_domains')->where('id', $row->id)->update($set);
        });
    }

    /** @param callable(StoreDomain): void $mutate */
    private function run(Request $request, string $domainId, callable $mutate): JsonResponse
    {
        abort_if(app()->environment('production') || ! config('domains.fake'), 404);
        $owner = $this->lookup->domainOwner($domainId) ?? throw new ApiException(404, 'not_found', 'Resource not found.');

        return $this->context->run($owner['tenant_id'], function () use ($request, $domainId, $mutate, $owner) {
            $row = StoreDomain::query()->whereKey(strtolower($domainId))->firstOrFail();
            if ($row->isPlatform()) {
                throw new ApiException(409, 'platform_domain_locked', 'Platform domains have no DNS records.');
            }
            $mutate($row);
            $row = StoreDomain::query()->findOrFail($row->id);
            if ($request->boolean('check')) {
                $row = $this->checker->check($row);
            }
            $store = Store::query()->findOrFail($owner['store_id']);

            return new JsonResponse(['data' => DomainPresenter::present($row, DomainPresenter::context($store, manage: false))]);
        });
    }
}
