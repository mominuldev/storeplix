<?php

declare(strict_types=1);

namespace App\Domain\Feeds\Drivers;

use App\Domain\Integrations\Models\StoreIntegration;

/**
 * FEEDS_FAKE=true (local / QA, never production): OAuth sends the browser straight back to the callback with a canned
 * code and returns canned tokens; every item is accepted. An item whose title contains "issue" (any case) is reported
 * disapproved with one issue so QA can walk "Needs attention"; the website claim succeeds.
 */
final class FakeFeedDriver implements FeedDriver
{
    /** @var array<string, list<string>> per integration: ids the fake "provider" holds (QA introspection) */
    public static array $held = [];

    /** @var array<string, string> variant id => title of the last upsert */
    private static array $titles = [];

    public function authorizeUrl(string $state, string $redirectUri): string
    {
        return $redirectUri.'?'.http_build_query(['code' => 'fake-code', 'state' => $state]);
    }

    public function exchangeCode(string $code, string $redirectUri): array
    {
        if ($code === 'fake-fail') {
            throw new FeedException(FeedException::REJECTED, 'Exchange refused (fake).');
        }

        return ['access_token' => 'fake-access-'.bin2hex(random_bytes(8)), 'refresh_token' => 'fake-refresh-'.bin2hex(random_bytes(8)), 'expires_at' => now()->addDays(60)->getTimestamp()];
    }

    public function refresh(StoreIntegration $integration): array
    {
        return ['access_token' => 'fake-access-'.bin2hex(random_bytes(8)), 'refresh_token' => $integration->secrets()['refresh_token'] ?? null, 'expires_at' => now()->addDays(60)->getTimestamp()];
    }

    public function revoke(StoreIntegration $integration): void {}

    public function accounts(StoreIntegration $integration): array
    {
        return [
            ['id' => '100200300', 'name' => 'Storeplix test catalog', 'parent_name' => 'Test business', 'item_count' => 0, 'parent_id' => '900800700'],
            ['id' => '100200301', 'name' => 'Second catalog', 'parent_name' => 'Test business', 'item_count' => 12, 'parent_id' => '900800700'],
        ];
    }

    public function prepareAccount(StoreIntegration $integration, ?string $accountId, ?string $parentId, string $newCatalogName): array
    {
        if ($accountId === null) {
            return ['settings' => ['business_id' => $parentId, 'business_name' => 'Test business', 'catalog_id' => '100200399', 'catalog_name' => $newCatalogName, 'merchant_id' => null], 'credentials' => []];
        }
        $account = collect($this->accounts($integration))->firstWhere('id', $accountId)
            ?? throw new FeedException(FeedException::ACCOUNT, 'Unknown account (fake).');

        return ['settings' => ['business_id' => $account['parent_id'], 'business_name' => $account['parent_name'], 'catalog_id' => $account['id'], 'catalog_name' => $account['name'],
            'merchant_id' => $account['id'], 'account_name' => $account['name']], 'credentials' => ['data_source' => 'accounts/'.$account['id'].'/dataSources/1']];
    }

    public function upsertItems(StoreIntegration $integration, array $items): array
    {
        foreach ($items as $item) {
            self::$held[$integration->id][] = (string) $item['id'];
            self::$titles[(string) $item['id']] = (string) $item['title'];
        }
        self::$held[$integration->id] = array_values(array_unique(self::$held[$integration->id] ?? []));

        return [];
    }

    public function deleteItems(StoreIntegration $integration, array $ids): void
    {
        self::$held[$integration->id] = array_values(array_diff(self::$held[$integration->id] ?? [], $ids));
    }

    public function fetchStatuses(StoreIntegration $integration, array $ids): array
    {
        $out = [];
        foreach ($ids as $id) {
            $issue = str_contains(strtolower(self::$titles[$id] ?? ''), 'issue');
            $out[$id] = $issue
                ? ['review_status' => 'disapproved', 'issues' => [['code' => 'image_too_small', 'severity' => 'error', 'message' => 'Image too small (fake): use at least 500 × 500 px.', 'attribute' => 'image_link', 'fix' => 'product_editor']]]
                : ['review_status' => 'approved', 'issues' => []];
        }

        return $out;
    }

    public function claimWebsite(StoreIntegration $integration, string $host, callable $publish): void
    {
        if (str_contains($host, 'claimfail')) {
            throw new FeedException(FeedException::REJECTED, 'Verification failed (fake).', 'verify');
        }
        $publish('fake-verification-'.substr(hash('sha256', $host), 0, 24));
    }
}
