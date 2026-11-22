<?php

declare(strict_types=1);

namespace App\Domain\Domains;

use App\Domain\Domains\Mail\DomainStatusMail;
use App\Domain\Identity\Models\User;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Revalidation\StorefrontRevalidation;
use App\Domain\Stores\Revalidation\StorefrontRevalidationObserver;
use App\Domain\Stores\Services\StorefrontResolver;
use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\Mail;

/**
 * Side effects of a routing change made with conditional UPDATEs (no model events): forget the resolver cache of the
 * hosts and revalidate the store once (P6-16), and the owner emails (P6-19).
 */
final class DomainNotifier
{
    public function __construct(
        private readonly StorefrontResolver $resolver,
        private readonly TenantContext $context,
    ) {}

    /** @param list<string> $hosts hosts whose routing changed (forgotten from the resolver cache) */
    public function routingChanged(string $tenantId, string $storeId, array $hosts): void
    {
        foreach (array_unique($hosts) as $host) {
            $this->resolver->forget($host);
        }
        if (! StorefrontRevalidation::isMuted()) {
            (new StorefrontRevalidationObserver)->dispatch($tenantId, $storeId);
        }
    }

    /** Owner-only email (Q76). Skipped (logged) when the owner has no verified email. */
    public function mail(string $tenantId, string $storeId, string $kind, string $hostname, ?string $detail = null, ?string $fallbackHost = null): void
    {
        $this->context->run($tenantId, function () use ($tenantId, $storeId, $kind, $hostname, $detail, $fallbackHost) {
            $ownerId = TenantUser::query()->where('tenant_id', $tenantId)->where('role', TenantUser::ROLE_OWNER)->value('user_id');
            $owner = $ownerId ? User::query()->find($ownerId) : null;
            if ($owner === null || $owner->email === null || $owner->email_verified_at === null) {
                Log::info('domains.mail_skipped', ['store_id' => $storeId, 'kind' => $kind]);

                return;
            }
            $shop = (string) Store::query()->whereKey($storeId)->value('name');
            Mail::to($owner->email)->send(new DomainStatusMail($kind, HostnameInput::display($hostname), $shop, $detail, $fallbackHost));
        });
    }
}
