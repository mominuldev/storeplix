<?php

declare(strict_types=1);

namespace App\Domain\Feeds\Drivers;

use App\Domain\Integrations\Models\StoreIntegration;

/**
 * PHASE-8-9D §7.3: one product-feed provider. Plain HTTP through fixed hosts (P89D-17); access tokens come from the
 * integration's encrypted credentials (FeedTokens refreshes them first). Errors throw FeedException.
 *
 * Item data (CatalogItemBuilder): {id, item_group_id, title, description, link, image_link, additional_image_links[],
 * price_amount, sale_price_amount|null, currency, availability (in stock|out of stock), brand, condition, language,
 * country}.
 */
interface FeedDriver
{
    public function authorizeUrl(string $state, string $redirectUri): string;

    /** @return array{access_token: string, refresh_token: string|null, expires_at: int|null} */
    public function exchangeCode(string $code, string $redirectUri): array;

    /** @return array{access_token: string, refresh_token: string|null, expires_at: int|null} */
    public function refresh(StoreIntegration $integration): array;

    public function revoke(StoreIntegration $integration): void;

    /** @return list<array{id: string, name: string, parent_name: string|null, item_count: int|null, parent_id: string|null}> */
    public function accounts(StoreIntegration $integration): array;

    /**
     * Chooses (or creates) the destination; returns the settings / internal credential fields to store.
     *
     * @return array{settings: array<string, mixed>, credentials: array<string, mixed>}
     */
    public function prepareAccount(StoreIntegration $integration, ?string $accountId, ?string $parentId, string $newCatalogName): array;

    /**
     * @param  list<array<string, mixed>>  $items
     * @return array<string, list<array<string, mixed>>> variant id => issues of items the provider refused at once (others accepted)
     */
    public function upsertItems(StoreIntegration $integration, array $items): array;

    /** @param list<string> $ids */
    public function deleteItems(StoreIntegration $integration, array $ids): void;

    /**
     * @param  list<string>  $ids
     * @return array<string, array{review_status: string|null, issues: list<array<string, mixed>>}>
     */
    public function fetchStatuses(StoreIntegration $integration, array $ids): array;

    /**
     * Google: token → publish (callback stores the META token for the storefront) → verify → claim. Throws FeedException
     * with `step` (token | verify | claim).
     *
     * @param  callable(string): void  $publish
     */
    public function claimWebsite(StoreIntegration $integration, string $host, callable $publish): void;
}
