<?php

declare(strict_types=1);

namespace App\Domain\Domains;

use App\Domain\Domains\Dns\ConsensusResolver;
use App\Domain\Domains\Dns\DnsCheckResult;
use App\Domain\Domains\Jobs\DeleteProviderHostnameJob;
use App\Domain\Domains\Mail\DomainStatusMail;
use App\Domain\Domains\Providers\CustomHostnameProvider;
use App\Domain\Domains\Providers\ProviderException;
use App\Domain\Domains\Providers\ProviderHostname;
use App\Domain\Stores\Models\StoreDomain;
use Carbon\CarbonImmutable;
use Illuminate\Contracts\Auth\Authenticatable;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\Log;

/**
 * PHASE-6-CONTRACT §2.3: one check of one custom domain, for its current status. Runs under DomainLock, inside the
 * domain's tenant (CheckDomainJob or the re-check endpoint). Every check records last_checked_at, check_attempts,
 * failure_code/message, last_check and next_check_at; status changes go through DomainStateMachine only.
 * Provider calls happen only from `verified` on (S52).
 */
final class DomainChecker
{
    public function __construct(
        private readonly ConsensusResolver $dns,
        private readonly CustomHostnameProvider $provider,
        private readonly DomainStateMachine $machine,
        private readonly DomainNotifier $notifier,
    ) {}

    public function check(StoreDomain $domain, ?Authenticatable $actor = null): StoreDomain
    {
        return DomainLock::run($domain->id, function () use ($domain, $actor) {
            $row = StoreDomain::query()->find($domain->id);
            if ($row === null || $row->isPlatform()) {
                return $row ?? $domain;
            }

            return match ($row->status) {
                StoreDomain::STATUS_PENDING_VERIFICATION => $this->checkPending($row, $actor),
                StoreDomain::STATUS_VERIFIED => $this->provision($row, $actor),
                StoreDomain::STATUS_SSL_PROVISIONING => $this->checkSsl($row, $actor),
                StoreDomain::STATUS_ACTIVE => $this->checkActive($row, $actor),
                default => $row,
            };
        });
    }

    /** The TXT + routing check of $row (P6-1–P6-3). */
    public function dns(StoreDomain $row): DnsCheckResult
    {
        return $this->dns->verify(
            $row->hostname,
            config('domains.txt_prefix').'.'.$row->hostname,
            'sp-verify='.$row->verification_token,
            (string) config('domains.cname_target'),
        );
    }

    private function checkPending(StoreDomain $row, ?Authenticatable $actor): StoreDomain
    {
        $dns = $this->dns($row);
        if ($dns->passed()) {
            $this->record($row, $dns, null);
            $verified = $this->machine->transition($row, StoreDomain::STATUS_VERIFIED, ['verified_at' => now(), 'first_failed_at' => null], actor: $actor);

            return $verified === null ? $this->fresh($row) : $this->provision($verified, $actor);
        }

        $deadline = CarbonImmutable::instance($row->verification_started_at ?? $row->created_at)->addHours((int) config('domains.verify_window_hours', 72));
        if (now()->greaterThanOrEqualTo($deadline)) {
            $this->record($row, $dns, $dns->failureCode());
            $last = $dns->failureCode();
            $message = DomainFailureCode::VerificationTimeout->message().($last !== null && $last !== DomainFailureCode::DnsError ? ' '.$last->message() : '');

            return $this->machine->transition($row, StoreDomain::STATUS_VERIFICATION_FAILED, [], DomainFailureCode::VerificationTimeout, $message, $actor)
                ?? $this->fresh($row);
        }

        return $this->record($row, $dns, $dns->failureCode());
    }

    /** `verified`: create the provider hostname (idempotent: a duplicate is looked up and adopted, P6-11). */
    private function provision(StoreDomain $row, ?Authenticatable $actor): StoreDomain
    {
        try {
            try {
                $hostname = $this->provider->create($row->hostname);
            } catch (ProviderException $e) {
                if ($e->kind !== ProviderException::DUPLICATE) {
                    throw $e;
                }
                $hostname = $this->provider->findByHostname($row->hostname)
                    ?? throw new ProviderException(ProviderException::ERROR, 'Duplicate hostname not found at the provider.');
            }

            return $this->machine->transition($row, StoreDomain::STATUS_SSL_PROVISIONING, [
                'provider' => $this->provider->name(),
                'provider_hostname_id' => $hostname->id,
                'provider_status' => mb_substr($hostname->status, 0, 32),
                'ssl_status' => $hostname->sslStatus !== null ? mb_substr($hostname->sslStatus, 0, 32) : null,
            ], actor: $actor) ?? $this->fresh($row);
        } catch (ProviderException|UniqueConstraintViolationException $e) {
            // A UniqueConstraintViolation = another row already references that provider hostname: never adopt it.
            Log::warning('domains.provider_create_failed', ['domain_id' => $row->id, 'kind' => $e instanceof ProviderException ? $e->kind : 'referenced']);
            $start = CarbonImmutable::instance($row->verified_at ?? $row->status_changed_at ?? now());
            if (now()->greaterThanOrEqualTo($start->addHours((int) config('domains.ssl_window_hours', 24)))) {
                return $this->machine->transition($row, StoreDomain::STATUS_VERIFICATION_FAILED, [], DomainFailureCode::ProviderError, actor: $actor)
                    ?? $this->fresh($row);
            }

            return $this->record($row, null, DomainFailureCode::ProviderError);
        }
    }

    /** `ssl_provisioning`: poll the provider (§5.2 mapping); 24 h without going live → failed. */
    private function checkSsl(StoreDomain $row, ?Authenticatable $actor): StoreDomain
    {
        $timedOut = now()->greaterThanOrEqualTo(CarbonImmutable::instance($row->status_changed_at ?? now())->addHours((int) config('domains.ssl_window_hours', 24)));
        try {
            $hostname = $row->provider_hostname_id !== null ? $this->provider->get($row->provider_hostname_id) : null;
        } catch (ProviderException) {
            return $timedOut ? $this->fail($row, DomainFailureCode::SslTimeout, $actor) : $this->record($row, null, DomainFailureCode::ProviderError);
        }
        if ($hostname === null) {
            return $this->fail($row, DomainFailureCode::ProviderError, $actor, deleteAtProvider: false);
        }
        $provider = ['provider_status' => mb_substr($hostname->status, 0, 32), 'ssl_status' => $hostname->sslStatus !== null ? mb_substr($hostname->sslStatus, 0, 32) : null];

        return match (true) {
            $hostname->hostnameState() === ProviderHostname::BLOCKED => $this->fail($row, DomainFailureCode::ProviderBlocked, $actor, $provider),
            $hostname->hostnameState() === ProviderHostname::MOVED => $this->fail($row, DomainFailureCode::ProviderMoved, $actor, $provider),
            $hostname->hostnameState() === ProviderHostname::GONE => $this->fail($row, DomainFailureCode::ProviderError, $actor, $provider),
            $hostname->sslState() === ProviderHostname::FAILED => $this->fail($row, DomainFailureCode::SslValidationFailed, $actor, $provider),
            $hostname->isLive() => $this->machine->transition($row, StoreDomain::STATUS_ACTIVE, $provider + ['activated_at' => now(), 'first_failed_at' => null], actor: $actor)
                ?? $this->fresh($row),
            $timedOut => $this->fail($row, DomainFailureCode::SslTimeout, $actor, $provider),
            default => $this->record($row, null, null, $provider),
        };
    }

    /** `active`: DNS and provider again (Q72); 7 days of failing checks → expired (P6-8 fallback, provider delete). */
    private function checkActive(StoreDomain $row, ?Authenticatable $actor): StoreDomain
    {
        $dns = $this->dns($row);
        $providerFailure = null;
        $provider = [];
        try {
            $hostname = $row->provider_hostname_id !== null ? $this->provider->get($row->provider_hostname_id) : null;
            if ($hostname === null) {
                $providerFailure = DomainFailureCode::SslLost;
            } else {
                $provider = ['provider_status' => mb_substr($hostname->status, 0, 32), 'ssl_status' => $hostname->sslStatus !== null ? mb_substr($hostname->sslStatus, 0, 32) : null];
                $providerFailure = match (true) {
                    in_array($hostname->hostnameState(), [ProviderHostname::MOVED, ProviderHostname::BLOCKED, ProviderHostname::GONE], true) => DomainFailureCode::ProviderMoved,
                    ! $hostname->isLive() => DomainFailureCode::SslLost,
                    default => null,
                };
            }
        } catch (ProviderException) {
            return $this->record($row, $dns, DomainFailureCode::ProviderError); // inconclusive: changes nothing
        }
        if ($dns->inconclusive()) {
            return $this->record($row, $dns, DomainFailureCode::DnsError, $provider);
        }

        $failure = $dns->failureCode() ?? $providerFailure;
        if ($failure === null) {
            return $this->record($row, $dns, null, $provider + ['first_failed_at' => null]);
        }

        $firstFailed = $row->first_failed_at !== null ? CarbonImmutable::instance($row->first_failed_at) : CarbonImmutable::now();
        if ($row->first_failed_at === null) {
            // P6-19: once per failure streak.
            $this->notifier->mail($row->tenant_id, $row->store_id, DomainStatusMail::DNS_MISSING, $row->hostname, $failure->message());
        }
        if ($firstFailed->lessThanOrEqualTo(now()->subDays((int) config('domains.expire_after_days', 7)))) {
            $this->record($row, $dns, $failure, $provider);

            return $this->fail($row->refresh(), $failure, $actor, $provider, StoreDomain::STATUS_EXPIRED);
        }

        return $this->record($row, $dns, $failure, $provider + ['first_failed_at' => $firstFailed]);
    }

    /**
     * Leaves the current status for verification_failed (or expired) and removes the provider hostname (job).
     *
     * @param  array<string, mixed>  $set
     */
    private function fail(StoreDomain $row, DomainFailureCode $code, ?Authenticatable $actor, array $set = [], string $to = StoreDomain::STATUS_VERIFICATION_FAILED, bool $deleteAtProvider = true): StoreDomain
    {
        $providerId = $row->provider_hostname_id;
        $done = $this->machine->transition($row, $to, $set + ['provider_hostname_id' => null], $code, actor: $actor);
        if ($done !== null && $providerId !== null && $deleteAtProvider) {
            DeleteProviderHostnameJob::dispatch((string) ($row->provider ?? $this->provider->name()), $providerId);
        }

        return $done ?? $this->fresh($row);
    }

    /**
     * Check bookkeeping without a status change (no model events: never revalidates the storefront, P6-16).
     *
     * @param  array<string, mixed>  $set
     */
    private function record(StoreDomain $row, ?DnsCheckResult $dns, ?DomainFailureCode $failure, array $set = []): StoreDomain
    {
        $now = now();
        $attempts = (int) $row->check_attempts + 1;
        $probe = clone $row;
        foreach ($set as $key => $value) {
            $probe->setAttribute($key, $value);
        }
        $attributes = $set + [
            'last_checked_at' => $now,
            'check_attempts' => $attempts,
            'next_check_at' => DomainCadence::next($probe, $attempts, $now),
            'failure_code' => $failure?->value,
            'failure_message' => $failure?->message(),
            'updated_at' => $now,
        ];
        if ($dns !== null) {
            $attributes['last_check'] = json_encode($dns->toLastCheck($now, $row->last_check), JSON_THROW_ON_ERROR | JSON_UNESCAPED_SLASHES);
        }
        StoreDomain::query()->whereKey($row->id)->where('status', $row->status)->update($attributes);

        return $this->fresh($row);
    }

    private function fresh(StoreDomain $row): StoreDomain
    {
        return StoreDomain::query()->find($row->id) ?? $row;
    }
}
