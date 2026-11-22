<?php

declare(strict_types=1);

namespace App\Domain\Domains\Providers;

/** P6-11 / §5.2: custom hostnames + certificates at the edge (Cloudflare for SaaS, or the fake). */
interface CustomHostnameProvider
{
    /** `cloudflare` | `fake` (store_domains.provider). */
    public function name(): string;

    /** @throws ProviderException (kind `duplicate` when the hostname already exists) */
    public function create(string $hostname): ProviderHostname;

    /** @throws ProviderException */
    public function findByHostname(string $hostname): ?ProviderHostname;

    /** null = the hostname no longer exists. @throws ProviderException */
    public function get(string $id): ?ProviderHostname;

    /** A missing hostname (404) counts as deleted. @throws ProviderException */
    public function delete(string $id): void;

    /**
     * Reconcile only.
     *
     * @return array{items: list<ProviderHostname>, has_more: bool}
     *
     * @throws ProviderException
     */
    public function list(int $page): array;
}
