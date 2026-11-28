<?php

declare(strict_types=1);

namespace App\Domain\Feeds\Drivers;

use App\Domain\Integrations\Models\StoreIntegration;
use Illuminate\Http\Client\PendingRequest;

/**
 * Meta catalog (PHASE-8-9D P89D-24): OAuth via Facebook Login for Business (config id), long-lived user token (≈ 60
 * days), catalogs of the user's businesses, items through the Catalog Batch API (`/{catalog_id}/items_batch`,
 * `PRODUCT_ITEM`, UPDATE / DELETE, ≤ 5,000 per request) and review status / errors from the catalog's products.
 * Endpoint and field names are VERIFY items. Needs a Meta app with Advanced Access (app review) in production.
 */
final class MetaCatalogDriver extends HttpFeedDriver
{
    private function graph(): PendingRequest
    {
        return $this->http((string) config('feeds.meta.graph_url'));
    }

    private function v(): string
    {
        return '/'.config('feeds.meta.version');
    }

    public function authorizeUrl(string $state, string $redirectUri): string
    {
        return rtrim((string) config('feeds.meta.dialog_url'), '/').$this->v().'/dialog/oauth?'.http_build_query(array_filter([
            'client_id' => config('feeds.meta.app_id'), 'redirect_uri' => $redirectUri, 'state' => $state, 'response_type' => 'code',
            'config_id' => config('feeds.meta.config_id'), 'scope' => config('feeds.meta.config_id') ? null : implode(',', (array) config('feeds.meta.scopes')),
        ]));
    }

    public function exchangeCode(string $code, string $redirectUri): array
    {
        $short = $this->call('meta_catalog', 'oauth.exchange', fn () => $this->graph()->get($this->v().'/oauth/access_token', [
            'client_id' => config('feeds.meta.app_id'), 'client_secret' => config('feeds.meta.app_secret'), 'redirect_uri' => $redirectUri, 'code' => $code,
        ]))->json('access_token');
        if (! is_string($short) || $short === '') {
            throw new FeedException(FeedException::REJECTED, 'No token returned.');
        }

        return $this->longLived($short);
    }

    public function refresh(StoreIntegration $integration): array
    {
        return $this->longLived($this->token($integration));
    }

    public function revoke(StoreIntegration $integration): void
    {
        $this->call('meta_catalog', 'oauth.revoke', fn () => $this->graph()->delete($this->v().'/me/permissions?'.http_build_query(['access_token' => $this->token($integration)])));
    }

    public function accounts(StoreIntegration $integration): array
    {
        $token = $this->token($integration);
        $businesses = (array) $this->call('meta_catalog', 'businesses', fn () => $this->graph()->get($this->v().'/me/businesses', ['fields' => 'id,name', 'access_token' => $token]))->json('data', []);
        $out = [];
        foreach (array_slice($businesses, 0, 25) as $b) {
            $catalogs = (array) $this->call('meta_catalog', 'catalogs', fn () => $this->graph()->get($this->v().'/'.rawurlencode((string) $b['id']).'/owned_product_catalogs',
                ['fields' => 'id,name,product_count', 'access_token' => $token]))->json('data', []);
            foreach ($catalogs as $c) {
                $out[] = ['id' => (string) $c['id'], 'name' => self::text($c['name'] ?? ''), 'parent_name' => self::text($b['name'] ?? ''),
                    'item_count' => isset($c['product_count']) ? (int) $c['product_count'] : null, 'parent_id' => (string) $b['id']];
            }
            if ($catalogs === []) {
                $out[] = ['id' => '', 'name' => '', 'parent_name' => self::text($b['name'] ?? ''), 'item_count' => null, 'parent_id' => (string) $b['id']];
            }
        }

        return array_values(array_filter($out, fn (array $o) => $o['id'] !== ''));
    }

    public function prepareAccount(StoreIntegration $integration, ?string $accountId, ?string $parentId, string $newCatalogName): array
    {
        if ($accountId === null) {
            $token = $this->token($integration);
            $id = $this->call('meta_catalog', 'catalog.create', fn () => $this->graph()->asForm()->post($this->v().'/'.rawurlencode((string) $parentId).'/owned_product_catalogs',
                ['name' => $newCatalogName, 'access_token' => $token]))->json('id');
            if (! is_string($id) || $id === '') {
                throw new FeedException(FeedException::ACCOUNT, 'The catalog was not created.');
            }

            return ['settings' => ['business_id' => $parentId, 'catalog_id' => $id, 'catalog_name' => $newCatalogName], 'credentials' => []];
        }
        foreach ($this->accounts($integration) as $a) {
            if ($a['id'] === $accountId) {
                return ['settings' => ['business_id' => $a['parent_id'], 'business_name' => $a['parent_name'], 'catalog_id' => $a['id'], 'catalog_name' => $a['name']], 'credentials' => []];
            }
        }

        throw new FeedException(FeedException::ACCOUNT, 'This catalog is not available to the connected account.');
    }

    public function upsertItems(StoreIntegration $integration, array $items): array
    {
        $requests = array_map(fn (array $i) => ['method' => 'UPDATE', 'data' => array_filter([
            'id' => $i['id'], 'item_group_id' => $i['item_group_id'], 'title' => $i['title'], 'description' => $i['description'],
            'availability' => $i['availability'], 'condition' => $i['condition'], 'price' => self::price($i['price_amount'], $i['currency']),
            'sale_price' => $i['sale_price_amount'] !== null ? self::price($i['sale_price_amount'], $i['currency']) : null,
            'link' => $i['link'], 'image_link' => $i['image_link'], 'additional_image_link' => $i['additional_image_links'] !== [] ? implode(',', $i['additional_image_links']) : null,
            'brand' => $i['brand'],
        ], fn ($v) => $v !== null)], $items);
        $this->batch($integration, $requests);

        return [];
    }

    public function deleteItems(StoreIntegration $integration, array $ids): void
    {
        $this->batch($integration, array_map(fn (string $id) => ['method' => 'DELETE', 'data' => ['id' => $id]], $ids));
    }

    public function fetchStatuses(StoreIntegration $integration, array $ids): array
    {
        if ($ids === []) {
            return [];
        }
        $token = $this->token($integration);
        $rows = (array) $this->call('meta_catalog', 'products', fn () => $this->graph()->get($this->v().'/'.rawurlencode((string) $integration->setting('catalog_id')).'/products', [
            'fields' => 'retailer_id,review_status,errors', 'limit' => min(count($ids), 1000), 'access_token' => $token,
            'filter' => json_encode(['retailer_id' => ['is_any' => array_values($ids)]]),
        ]))->json('data', []);
        $out = [];
        foreach ($rows as $row) {
            $issues = [];
            foreach ((array) ($row['errors'] ?? []) as $e) {
                $issues[] = ['code' => self::text($e['error_type'] ?? 'meta_error'), 'severity' => ($e['error_priority'] ?? '') === 'HIGH' ? 'error' : 'warning',
                    'message' => self::text($e['title'] ?? $e['description'] ?? ''), 'attribute' => null, 'fix' => 'product_editor'];
            }
            $out[(string) ($row['retailer_id'] ?? '')] = ['review_status' => match (strtolower((string) ($row['review_status'] ?? ''))) {
                'approved' => 'approved', 'rejected' => 'disapproved', 'pending' => 'in_review', default => null,
            }, 'issues' => $issues];
        }

        return $out;
    }

    public function claimWebsite(StoreIntegration $integration, string $host, callable $publish): void
    {
        throw new FeedException(FeedException::REJECTED, 'Not supported.', 'token');
    }

    /** @param list<array<string, mixed>> $requests */
    private function batch(StoreIntegration $integration, array $requests): void
    {
        $token = $this->token($integration);
        foreach (array_chunk($requests, (int) config('feeds.meta.batch_size', 5000)) as $chunk) {
            $this->call('meta_catalog', 'items_batch', fn () => $this->graph()->post($this->v().'/'.rawurlencode((string) $integration->setting('catalog_id')).'/items_batch',
                ['item_type' => 'PRODUCT_ITEM', 'allow_upsert' => true, 'requests' => $chunk, 'access_token' => $token]));
        }
    }

    /** @return array{access_token: string, refresh_token: string|null, expires_at: int|null} */
    private function longLived(string $token): array
    {
        $response = $this->call('meta_catalog', 'oauth.long_lived', fn () => $this->graph()->get($this->v().'/oauth/access_token', [
            'grant_type' => 'fb_exchange_token', 'client_id' => config('feeds.meta.app_id'), 'client_secret' => config('feeds.meta.app_secret'), 'fb_exchange_token' => $token,
        ]));
        $long = $response->json('access_token');
        if (! is_string($long) || $long === '') {
            throw new FeedException(FeedException::REJECTED, 'No long-lived token returned.');
        }

        return ['access_token' => $long, 'refresh_token' => null, 'expires_at' => now()->addSeconds((int) ($response->json('expires_in') ?? 60 * 86400))->getTimestamp()];
    }
}
