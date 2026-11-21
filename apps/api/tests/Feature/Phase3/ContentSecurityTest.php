<?php

namespace Tests\Feature\Phase3;

use App\Domain\Tenancy\Models\TenantUser;
use App\Domain\Themes\Models\StoreTheme;
use Illuminate\Foundation\Testing\RefreshDatabase;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\StorefrontContent;
use Tests\TestCase;

/** PHASE-3-CONTRACT §8/§9 security group. */
#[Group('security')]
class ContentSecurityTest extends TestCase
{
    use RefreshDatabase, StorefrontContent;

    private const HOSTILE_LINKS = [
        'javascript:alert(1)', ' JaVaScRiPt:alert(1)', "java\tscript:alert(1)", '%6a%61vascript:alert(1)',
        'data:text/html,<script>alert(1)</script>', '//evil.com', '/\\evil.com', 'https://user:pw@x.com',
    ];

    private function richTextSection(array $content): array
    {
        $config = $this->defaultConfig();
        $config['sections'][] = ['id' => 'rtxt000001', 'type' => 'rich-text', 'enabled' => true, 'settings' => [
            'heading' => null, 'doc' => ['type' => 'doc', 'content' => $content], 'align' => 'left', 'width' => 'narrow',
        ]];

        return $config;
    }

    public function test_rich_text_is_json_never_html_and_hostile_links_are_rejected(): void
    {
        [$user, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'shop');
        $headers = $this->tenantHeaders($user, $tenant);
        $script = '<script>alert(document.cookie)</script><img src=x onerror=alert(1)>';

        // Script markup is plain text: stored and returned verbatim, never interpreted server-side.
        $page = $this->flushHeaders()->withHeaders($headers)->postJson("/api/v1/stores/{$store->id}/pages", [
            'title' => 'XSS', 'status' => 'published',
            'body' => [$this->richTextBlock('rt00000001', [['type' => 'paragraph', 'content' => [['type' => 'text', 'text' => $script]]]])],
        ])->assertCreated()->assertJsonPath('data.body.0.doc.content.0.content.0.text', $script);
        $this->storefront('/pages/'.$page->json('data.slug'), 'shop.storeplix.test')
            ->assertJsonPath('data.body.0.doc.content.0.content.0.text', $script);
        $this->saveDraft($headers, $store, $this->richTextSection([['type' => 'paragraph', 'content' => [['type' => 'text', 'text' => $script]]]]), 1)
            ->assertOk()->assertJsonPath('data.draft_config.sections.10.settings.doc.content.0.content.0.text', $script);

        $unknownNodes = [
            [['type' => 'html', 'content' => [['type' => 'text', 'text' => '<b>x</b>']]]],
            [['type' => 'paragraph', 'content' => [['type' => 'image', 'attrs' => ['src' => 'x']]]]],
            [['type' => 'paragraph', 'content' => [['type' => 'text', 'text' => 'x', 'marks' => [['type' => 'textStyle', 'attrs' => ['color' => 'red']]]]]]],
            [['type' => 'paragraph', 'attrs' => ['style' => 'x'], 'content' => []]],
            [['type' => 'paragraph', 'content' => [['type' => 'text', 'text' => 'x', 'marks' => [['type' => 'link', 'attrs' => ['href' => '/', 'target' => '_blank']]]]]]],
            [['type' => 'bulletList', 'content' => [['type' => 'listItem', 'content' => [['type' => 'bulletList', 'content' => []]]]]]],
        ];
        foreach ($unknownNodes as $content) {
            $this->flushHeaders()->withHeaders($headers)->postJson("/api/v1/stores/{$store->id}/pages", ['title' => 'X', 'body' => [$this->richTextBlock('rt00000001', $content)]])
                ->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
            $this->saveDraft($headers, $store, $this->richTextSection($content), 2)->assertStatus(422);
        }

        foreach (self::HOSTILE_LINKS as $href) {
            $this->flushHeaders()->withHeaders($headers)->postJson("/api/v1/stores/{$store->id}/pages", ['title' => 'X', 'body' => [$this->richTextBlock('rt00000001', [$this->linkParagraph($href)])]])
                ->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['body.0.doc.content.0.content.0.marks.0.attrs.href']]]);
            $this->flushHeaders()->withHeaders($headers)->postJson("/api/v1/stores/{$store->id}/pages", ['title' => 'X', 'body' => [
                ['id' => 'btn0000001', 'type' => 'button', 'label' => 'Go', 'href' => $href, 'style' => 'primary'],
            ]])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['body.0.href']]]);
            $this->saveDraft($headers, $store, $this->richTextSection([$this->linkParagraph($href)]), 2)->assertStatus(422);

            $config = $this->defaultConfig();
            $config['sections'][0]['settings']['primaryCtaHref'] = $href;
            $this->saveDraft($headers, $store, $config, 2)->assertStatus(422)
                ->assertJsonStructure(['error' => ['details' => ['config.sections.0.settings.primaryCtaHref']]]);
        }
    }

    public function test_navigation_urls_allow_only_http_and_https(): void
    {
        [$user, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'shop');
        $headers = $this->tenantHeaders($user, $tenant);
        $save = fn (string $url, int $revision) => $this->flushHeaders()->withHeaders($headers)->putJson("/api/v1/stores/{$store->id}/navigation/main", [
            'revision' => $revision, 'items' => [['id' => 'link000001', 'label' => 'X', 'link' => ['type' => 'url', 'url' => $url]]],
        ]);

        $save('http://x.com', 1)->assertOk();
        foreach (['ftp://x.com', 'javascript:alert(1)', 'data:text/html,x', '//evil.com', 'https://u:p@x.com', 'https://x.com/a b', '/relative'] as $url) {
            $save($url, 2)->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['items.0.link.url']]]);
        }
    }

    public function test_colours_fonts_and_unknown_keys_cannot_inject_css(): void
    {
        [$user, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'shop');
        $headers = $this->tenantHeaders($user, $tenant);

        foreach (['red', '#fff;}body{display:none', 'url(x)', '#fff', 'expression(alert(1))'] as $colour) {
            $config = $this->defaultConfig();
            $config['settings']['primaryColor'] = $colour;
            $this->saveDraft($headers, $store, $config, 1)->assertStatus(422)
                ->assertJsonStructure(['error' => ['details' => ['config.settings.primaryColor']]]);
        }

        $config = $this->defaultConfig();
        $config['settings']['backgroundColor'] = '#FFFFFF';
        $config['sections'][0]['settings']['design'] = ['background' => 'custom', 'customBackground' => '#ABCDEF', 'textTone' => 'auto',
            'paddingTop' => 64, 'paddingBottom' => 48, 'visibility' => ['desktop' => true, 'tablet' => true, 'phone' => true]];
        $this->saveDraft($headers, $store, $config, 1)->assertOk()
            ->assertJsonPath('data.draft_config.settings.backgroundColor', '#ffffff')
            ->assertJsonPath('data.draft_config.sections.0.settings.design.customBackground', '#abcdef');

        $config = $this->defaultConfig();
        $config['settings']['fontFamily'] = 'Comic Sans';
        $this->saveDraft($headers, $store, $config, 2)->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['config.settings.fontFamily']]]);

        $config = $this->defaultConfig();
        $config['settings']['customCss'] = 'body{}';
        $this->saveDraft($headers, $store, $config, 2)->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['config.settings.customCss']]]);
    }

    public function test_payload_and_section_limits(): void
    {
        [$user, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'shop');
        $headers = $this->tenantHeaders($user, $tenant);

        $config = $this->defaultConfig();
        $config['settings']['announcement']['text'] = str_repeat('x', 70_000);
        $this->saveDraft($headers, $store, $config, 1)->assertStatus(413)->assertJsonPath('error.code', 'payload_too_large');

        $config = $this->defaultConfig();
        $template = $config['sections'][1]; // chip-links
        $config['sections'] = [];
        for ($i = 0; $i < 31; $i++) {
            $config['sections'][] = ['id' => 'sec'.str_pad((string) $i, 7, '0', STR_PAD_LEFT)] + $template;
        }
        $this->saveDraft($headers, $store, $config, 1)->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['config.sections']]]);
        $this->assertSame(1, StoreTheme::withoutTenancy()->where('store_id', $store->id)->value('draft_revision'));
    }

    public function test_concurrent_draft_saves_conflict(): void
    {
        [$user, $tenant] = $this->merchant();
        [$other] = $this->merchant(TenantUser::ROLE_ADMIN, $tenant);
        $store = $this->storeFor($tenant, 'shop');

        $this->saveDraft($this->tenantHeaders($user, $tenant), $store, $this->defaultConfig(), 1)->assertOk();
        $this->saveDraft($this->tenantHeaders($other, $tenant), $store, $this->defaultConfig(), 1)
            ->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');
    }

    public function test_staff_can_read_but_every_write_is_403(): void
    {
        [$owner, $tenant] = $this->merchant();
        [$staff] = $this->merchant(TenantUser::ROLE_STAFF, $tenant);
        $store = $this->storeFor($tenant, 'shop');
        $headers = $this->tenantHeaders($staff, $tenant) + ['X-Storefront-Preview' => $this->previewToken($store)];
        $base = "/api/v1/stores/{$store->id}";
        $page = $this->flushHeaders()->withHeaders($headers)->getJson("{$base}/pages")->assertOk()->json('data.0.id');

        foreach (['/api/v1/themes', '/api/v1/page-templates', "{$base}/themes", "{$base}/themes/modern-commerce", "{$base}/pages", "{$base}/pages/{$page}", "{$base}/navigation", '/api/v1/media', "{$base}/settings"] as $url) {
            $this->flushHeaders()->withHeaders($headers)->getJson($url)->assertOk();
        }

        // The preview header never authorises anything on merchant routes.
        $writes = [
            ['PUT', "{$base}/themes/modern-commerce/draft", ['config' => $this->defaultConfig(), 'base_revision' => 1]],
            ['POST', "{$base}/themes/modern-commerce/publish", ['draft_revision' => 1]],
            ['POST', "{$base}/themes/modern-commerce/discard"],
            ['POST', "{$base}/themes/modern-commerce/apply"],
            ['POST', "{$base}/pages", ['title' => 'Staff page']],
            ['PATCH', "{$base}/pages/{$page}", ['revision' => 1, 'title' => 'Staff edit']],
            ['DELETE', "{$base}/pages/{$page}"],
            ['PUT', "{$base}/navigation/main", ['items' => [], 'revision' => 1]],
            ['PATCH', "{$base}/settings", ['seo' => ['hide_from_search' => true]]],
        ];
        foreach ($writes as $write) {
            $this->flushHeaders()->withHeaders($headers)->json($write[0], $write[1], $write[2] ?? [])
                ->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        }

        $theme = StoreTheme::withoutTenancy()->where('store_id', $store->id)->sole();
        $this->assertSame(1, $theme->draft_revision);
        $this->assertNull($theme->applied_at);
    }
}
