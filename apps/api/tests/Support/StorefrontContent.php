<?php

namespace Tests\Support;

use App\Domain\Identity\Models\User;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Preview\PreviewTokenService;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Themes\ThemeRegistry;
use Illuminate\Http\UploadedFile;
use Illuminate\Testing\TestResponse;

/** Phase 3 test helpers (themes, pages, navigation, storefront). */
trait StorefrontContent
{
    /** @return array<string, mixed> */
    protected function defaultConfig(): array
    {
        return app(ThemeRegistry::class)->defaults('modern-commerce');
    }

    protected function themeUrl(Store $store, string $suffix = ''): string
    {
        return "/api/v1/stores/{$store->id}/themes/modern-commerce{$suffix}";
    }

    /** @param array<string, string> $headers */
    protected function saveDraft(array $headers, Store $store, array $config, int $base): TestResponse
    {
        return $this->flushHeaders()->withHeaders($headers)
            ->putJson($this->themeUrl($store, '/draft'), ['config' => $config, 'base_revision' => $base]);
    }

    protected function storefront(string $path, string $host, ?string $preview = null): TestResponse
    {
        return $this->flushHeaders()->withHeaders(array_filter([
            'X-Storefront-Key' => 'test-storefront-key',
            'X-Storefront-Host' => $host,
            'X-Storefront-Preview' => $preview,
        ], fn ($v) => $v !== null))->getJson('/api/v1/storefront'.$path);
    }

    protected function previewToken(Store $store): string
    {
        return app(PreviewTokenService::class)->issue($store)['token'];
    }

    /** Upload real image bytes; returns the media id. */
    protected function uploadMedia(User $user, Tenant $tenant, string $purpose = 'page_image', int $size = 400): string
    {
        return $this->flushHeaders()->withHeaders($this->tenantHeaders($user, $tenant))
            ->post('/api/v1/media', [
                'file' => UploadedFile::fake()->createWithContent('i.png', $this->imageBytes($size, $size)),
                'purpose' => $purpose,
            ], ['Accept' => 'application/json'])
            ->assertCreated()->json('data.id');
    }

    /** @return array<string, mixed> a rich-text page block */
    protected function richTextBlock(string $id, array $content): array
    {
        return ['id' => $id, 'type' => 'rich_text', 'doc' => ['type' => 'doc', 'content' => $content]];
    }

    /** @return array<string, mixed> a paragraph with one linked text node */
    protected function linkParagraph(string $href): array
    {
        return ['type' => 'paragraph', 'content' => [
            ['type' => 'text', 'text' => 'click', 'marks' => [['type' => 'link', 'attrs' => ['href' => $href]]]],
        ]];
    }

    /**
     * Cross-tenant resource access (MULTI-TENANCY §10a): every URL of tenant B's resource → 404 for tenant A.
     *
     * @param  array<string, string>  $headersA
     * @param  list<array{0: string, 1: string, 2?: array<string, mixed>}>  $requests  [method, url, body?]
     */
    protected function assertTenantIsolation(array $headersA, array $requests): void
    {
        foreach ($requests as $request) {
            [$method, $url] = $request;
            $this->flushHeaders()->withHeaders($headersA)->json($method, $url, $request[2] ?? [])
                ->assertNotFound()
                ->assertJsonPath('error.code', 'not_found');
        }
    }
}
