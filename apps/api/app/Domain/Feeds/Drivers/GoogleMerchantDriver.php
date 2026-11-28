<?php

declare(strict_types=1);

namespace App\Domain\Feeds\Drivers;

use App\Domain\Integrations\Models\StoreIntegration;
use Illuminate\Http\Client\PendingRequest;

/**
 * Google Merchant Center through the **Merchant API** (PHASE-8-9D P89D-25, Q346 open — default in effect; the Content
 * API for Shopping is being shut down): OAuth (scopes content + siteverification, offline, consent), accounts,
 * a Storeplix API data source per account, `productInputs:insert` / delete, product statuses (`itemLevelIssues`), and
 * the website claim through the Site Verification API (META method) + `homepage:claim`. Paths and versions VERIFY.
 */
final class GoogleMerchantDriver extends HttpFeedDriver
{
    private function api(): PendingRequest
    {
        return $this->http((string) config('feeds.google.merchant_url'));
    }

    private function v(): string
    {
        return (string) config('feeds.google.merchant_version', 'v1');
    }

    public function authorizeUrl(string $state, string $redirectUri): string
    {
        return rtrim((string) config('feeds.google.auth_url'), '/').'/o/oauth2/v2/auth?'.http_build_query([
            'client_id' => config('feeds.google.client_id'), 'redirect_uri' => $redirectUri, 'response_type' => 'code', 'state' => $state,
            'scope' => implode(' ', (array) config('feeds.google.scopes')), 'access_type' => 'offline', 'prompt' => 'consent', 'include_granted_scopes' => 'true',
        ]);
    }

    public function exchangeCode(string $code, string $redirectUri): array
    {
        return $this->tokens(['grant_type' => 'authorization_code', 'code' => $code, 'redirect_uri' => $redirectUri]);
    }

    public function refresh(StoreIntegration $integration): array
    {
        $refresh = $integration->secrets()['refresh_token'] ?? null;
        if (! is_string($refresh) || $refresh === '') {
            throw new FeedException(FeedException::AUTH, 'No refresh token.');
        }
        $tokens = $this->tokens(['grant_type' => 'refresh_token', 'refresh_token' => $refresh]);
        $tokens['refresh_token'] ??= $refresh;

        return $tokens;
    }

    public function revoke(StoreIntegration $integration): void
    {
        $token = $integration->secrets()['refresh_token'] ?? $integration->secrets()['access_token'] ?? '';
        $this->call('google_merchant', 'oauth.revoke', fn () => $this->http((string) config('feeds.google.token_url'))->asForm()->post('/revoke', ['token' => $token]));
    }

    public function accounts(StoreIntegration $integration): array
    {
        $token = $this->token($integration);
        $rows = (array) $this->call('google_merchant', 'accounts', fn () => $this->api()->withToken($token)->get('/accounts/'.$this->v().'/accounts', ['pageSize' => 250]))->json('accounts', []);

        return array_values(array_map(fn (array $a) => [
            'id' => (string) ($a['accountId'] ?? basename((string) ($a['name'] ?? ''))), 'name' => self::text($a['accountName'] ?? ''), 'parent_name' => null, 'item_count' => null, 'parent_id' => null,
        ], $rows));
    }

    public function prepareAccount(StoreIntegration $integration, ?string $accountId, ?string $parentId, string $newCatalogName): array
    {
        $account = collect($this->accounts($integration))->firstWhere('id', (string) $accountId)
            ?? throw new FeedException(FeedException::ACCOUNT, 'This Merchant Center account is not available to the connected Google account.');
        $token = $this->token($integration);
        $language = (string) $integration->setting('feed_language', 'bn');
        $source = $this->call('google_merchant', 'datasource.create', fn () => $this->api()->withToken($token)->post('/datasources/'.$this->v().'/accounts/'.rawurlencode($account['id']).'/dataSources', [
            'displayName' => $newCatalogName, 'primaryProductDataSource' => ['contentLanguage' => $language, 'feedLabel' => 'BD', 'countries' => ['BD']],
        ]))->json('name');
        if (! is_string($source) || $source === '') {
            throw new FeedException(FeedException::ACCOUNT, 'The Storeplix data source was not created.');
        }

        return ['settings' => ['merchant_id' => $account['id'], 'account_name' => $account['name']], 'credentials' => ['data_source' => $source]];
    }

    public function upsertItems(StoreIntegration $integration, array $items): array
    {
        $token = $this->token($integration);
        $refused = [];
        foreach ($items as $i) {
            try {
                $this->call('google_merchant', 'productInputs.insert', fn () => $this->api()->withToken($token)
                    ->post('/products/'.$this->v().'/accounts/'.rawurlencode((string) $integration->setting('merchant_id')).'/productInputs:insert?'.http_build_query(['dataSource' => $this->source($integration)]), [
                        'offerId' => $i['id'], 'contentLanguage' => $i['language'], 'feedLabel' => 'BD',
                        'productAttributes' => array_filter([
                            'title' => $i['title'], 'description' => $i['description'], 'link' => $i['link'], 'imageLink' => $i['image_link'],
                            'additionalImageLinks' => $i['additional_image_links'] ?: null, 'availability' => str_replace(' ', '_', $i['availability']),
                            'condition' => $i['condition'], 'brand' => $i['brand'], 'itemGroupId' => $i['item_group_id'], 'identifierExists' => false,
                            'price' => ['amountMicros' => (string) ($i['price_amount'] * 10_000), 'currencyCode' => $i['currency']],
                            'salePrice' => $i['sale_price_amount'] !== null ? ['amountMicros' => (string) ($i['sale_price_amount'] * 10_000), 'currencyCode' => $i['currency']] : null,
                        ], fn ($v) => $v !== null),
                    ]));
            } catch (FeedException $e) {
                if ($e->reason !== FeedException::REJECTED) {
                    throw $e;
                }
                $refused[(string) $i['id']] = [['code' => 'invalid_item', 'severity' => 'error', 'message' => 'Google refused this item.', 'attribute' => null, 'fix' => 'product_editor']];
            }
        }

        return $refused;
    }

    public function deleteItems(StoreIntegration $integration, array $ids): void
    {
        $token = $this->token($integration);
        $language = (string) $integration->setting('feed_language', 'bn');
        foreach ($ids as $id) {
            try {
                $this->call('google_merchant', 'productInputs.delete', fn () => $this->api()->withToken($token)
                    ->delete('/products/'.$this->v().'/accounts/'.rawurlencode((string) $integration->setting('merchant_id')).'/productInputs/'.rawurlencode("{$language}~BD~{$id}").'?'.http_build_query(['dataSource' => $this->source($integration)])));
            } catch (FeedException $e) {
                if ($e->reason !== FeedException::REJECTED) {
                    throw $e; // a 404 (already gone) is fine
                }
            }
        }
    }

    public function fetchStatuses(StoreIntegration $integration, array $ids): array
    {
        if ($ids === []) {
            return [];
        }
        $token = $this->token($integration);
        $rows = (array) $this->call('google_merchant', 'products.list', fn () => $this->api()->withToken($token)
            ->get('/products/'.$this->v().'/accounts/'.rawurlencode((string) $integration->setting('merchant_id')).'/products', ['pageSize' => 1000]))->json('products', []);
        $wanted = array_flip($ids);
        $out = [];
        foreach ($rows as $p) {
            $offer = (string) ($p['offerId'] ?? '');
            if (! isset($wanted[$offer])) {
                continue;
            }
            $issues = [];
            $disapproved = false;
            foreach ((array) ($p['productStatus']['itemLevelIssues'] ?? []) as $issue) {
                $severity = ($issue['severity'] ?? '') === 'DISAPPROVED' ? 'error' : 'warning';
                $disapproved = $disapproved || $severity === 'error';
                $issues[] = ['code' => self::text($issue['code'] ?? 'google_issue'), 'severity' => $severity, 'message' => self::text($issue['description'] ?? ''),
                    'attribute' => isset($issue['attribute']) ? self::text($issue['attribute']) : null, 'fix' => 'product_editor'];
            }
            $states = array_column((array) ($p['productStatus']['destinationStatuses'] ?? []), 'approvedCountries');
            $out[$offer] = ['review_status' => $disapproved ? 'disapproved' : ($issues !== [] ? 'limited' : ($states !== [] ? 'approved' : 'in_review')), 'issues' => $issues];
        }

        return $out;
    }

    public function claimWebsite(StoreIntegration $integration, string $host, callable $publish): void
    {
        $token = $this->token($integration);
        $site = ['type' => 'SITE', 'identifier' => "https://{$host}/"];
        $verifier = $this->http((string) config('feeds.google.site_verification_url'))->withToken($token);
        $meta = (string) $this->call('google_merchant', 'siteverification.token', fn () => $verifier->post('/siteVerification/v1/token', ['site' => $site, 'verificationMethod' => 'META']), 'token')->json('token');
        $content = preg_match('/content="([A-Za-z0-9_-]{10,100})"/', $meta, $m) === 1 ? $m[1] : (preg_match('/^[A-Za-z0-9_-]{10,100}$/', $meta) === 1 ? $meta : null);
        if ($content === null) {
            throw new FeedException(FeedException::REJECTED, 'Google returned no verification token.', 'token');
        }
        $publish($content);
        $this->call('google_merchant', 'siteverification.verify', fn () => $verifier->post('/siteVerification/v1/webResource?verificationMethod=META', ['site' => $site]), 'verify');
        $account = rawurlencode((string) $integration->setting('merchant_id'));
        $this->call('google_merchant', 'homepage.update', fn () => $this->api()->withToken($token)->patch('/accounts/'.$this->v()."/accounts/{$account}/homepage?updateMask=uri", ['uri' => "https://{$host}/"]), 'claim');
        $this->call('google_merchant', 'homepage.claim', fn () => $this->api()->withToken($token)->post('/accounts/'.$this->v()."/accounts/{$account}/homepage:claim", []), 'claim');
    }

    /** @param array<string, string> $grant @return array{access_token: string, refresh_token: string|null, expires_at: int|null} */
    private function tokens(array $grant): array
    {
        $response = $this->call('google_merchant', 'oauth.token', fn () => $this->http((string) config('feeds.google.token_url'))->asForm()->post('/token', $grant + [
            'client_id' => config('feeds.google.client_id'), 'client_secret' => config('feeds.google.client_secret'),
        ]));
        $access = $response->json('access_token');
        if (! is_string($access) || $access === '') {
            throw new FeedException(FeedException::REJECTED, 'No token returned.');
        }

        return ['access_token' => $access, 'refresh_token' => is_string($response->json('refresh_token')) ? $response->json('refresh_token') : null,
            'expires_at' => now()->addSeconds((int) ($response->json('expires_in') ?? 3600))->getTimestamp()];
    }

    private function source(StoreIntegration $integration): string
    {
        return (string) ($integration->secrets()['data_source'] ?? '');
    }
}
