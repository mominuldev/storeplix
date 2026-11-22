<?php

namespace Tests\Feature\Pages;

use App\Domain\Pages\Models\StorePage;
use App\Domain\Stores\Revalidation\RevalidateStorefront;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Queue;
use Tests\Support\StorefrontContent;
use Tests\TestCase;

class PageTest extends TestCase
{
    use RefreshDatabase, StorefrontContent;

    public function test_templates_are_listed_in_contract_order(): void
    {
        [$staff, $tenant] = $this->merchant(TenantUser::ROLE_STAFF);

        $this->withHeaders($this->tenantHeaders($staff, $tenant))->getJson('/api/v1/page-templates')
            ->assertOk()
            ->assertJsonCount(10, 'data')
            ->assertJsonPath('data.0.code', 'blank')
            ->assertJsonPath('data.0.default_slug', null)
            ->assertJsonPath('data.9.code', 'returns')
            ->assertJsonPath('data.9.default_slug', 'delivery-return')
            ->assertJsonStructure(['data' => ['*' => ['code', 'name', 'description', 'category', 'default_title', 'default_slug', 'highlights']]]);
    }

    public function test_new_store_gets_default_pages(): void
    {
        [$user, $tenant] = $this->merchant(TenantUser::ROLE_STAFF);
        $store = $this->storeFor($tenant, 'shop');

        $response = $this->withHeaders($this->tenantHeaders($user, $tenant))->getJson("/api/v1/stores/{$store->id}/pages")
            ->assertOk()
            ->assertJsonPath('meta.counts', ['all' => 5, 'draft' => 3, 'published' => 2, 'hidden' => 0])
            ->assertJsonPath('meta.limit', 50);

        $bySlug = collect($response->json('data'))->keyBy('slug');
        $this->assertSame(['about', 'contact', 'delivery-return', 'privacy', 'terms'], $bySlug->keys()->sort()->values()->all());
        $this->assertSame('published', $bySlug['about']['status']);
        $this->assertSame(['main'], $bySlug['about']['in_menus']);
        $this->assertSame(['help'], $bySlug['privacy']['in_menus']);
        $this->assertSame('/pages/delivery-return', $bySlug['delivery-return']['url_path']);
    }

    public function test_crud_with_template_placeholders_and_add_to_menu(): void
    {
        [$user, $tenant] = $this->merchant(TenantUser::ROLE_ADMIN);
        $store = $this->storeFor($tenant, 'shop');
        $headers = $this->tenantHeaders($user, $tenant);
        $this->withHeaders($headers)->patchJson("/api/v1/stores/{$store->id}/settings", ['contact' => ['phone' => '01712345678']])->assertOk();

        // FAQ: phone filled in; no email set, so nothing mentions an email.
        $page = $this->withHeaders($headers)->postJson("/api/v1/stores/{$store->id}/pages", ['template' => 'faq', 'add_to_menu' => 'footer'])
            ->assertCreated()
            ->assertJsonPath('data.slug', 'faq')
            ->assertJsonPath('data.title', 'FAQ')
            ->assertJsonPath('data.status', 'draft')
            ->assertJsonPath('data.template', 'faq')
            ->assertJsonPath('data.in_menus', ['footer'])
            ->assertJsonPath('data.revision', 1)
            ->assertJsonPath('data.updated_by.id', $user->id)
            ->json('data');
        $text = json_encode($page['body']);
        $this->assertStringContainsString('+8801712345678', $text);
        $this->assertStringNotContainsString('{store_', $text);
        $this->assertStringNotContainsString('{support_hours}', $text);

        // Same template again → slug auto-suffixed (it wasn't chosen by the merchant).
        $this->withHeaders($headers)->postJson("/api/v1/stores/{$store->id}/pages", ['template' => 'faq'])
            ->assertCreated()->assertJsonPath('data.slug', 'faq-2');

        // Explicit duplicate / reserved slugs → 422.
        $this->withHeaders($headers)->postJson("/api/v1/stores/{$store->id}/pages", ['title' => 'X', 'slug' => 'faq'])
            ->assertStatus(422)->assertJsonPath('error.details.slug.0', 'This link is already used by another page.');
        foreach (['cart', 'checkout', '_next', 'pages'] as $reserved) {
            $this->withHeaders($headers)->postJson("/api/v1/stores/{$store->id}/pages", ['title' => 'X', 'slug' => $reserved])
                ->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['slug']]]);
        }

        // Blank page; Bangla-only title → page-xxxxxx slug.
        $this->withHeaders($headers)->postJson("/api/v1/stores/{$store->id}/pages", ['title' => 'Our Story & Mission!'])
            ->assertCreated()->assertJsonPath('data.slug', 'our-story-mission')->assertJsonPath('data.body', []);
        $slug = $this->withHeaders($headers)->postJson("/api/v1/stores/{$store->id}/pages", ['title' => 'আমাদের গল্প'])
            ->assertCreated()->json('data.slug');
        $this->assertMatchesRegularExpression('/^page-[a-z0-9]{6}$/', $slug);
        $this->withHeaders($headers)->postJson("/api/v1/stores/{$store->id}/pages", [])->assertStatus(422)
            ->assertJsonStructure(['error' => ['details' => ['title']]]);

        // Update: revision required and checked; first publish sets published_at.
        $url = "/api/v1/stores/{$store->id}/pages/{$page['id']}";
        $this->withHeaders($headers)->patchJson($url, ['title' => 'x'])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['revision']]]);
        $this->withHeaders($headers)->patchJson($url, ['revision' => 1, 'template' => 'about'])->assertStatus(422);
        $this->withHeaders($headers)->patchJson($url, ['revision' => 1, 'status' => 'published', 'title' => 'Questions', 'seo' => ['title' => 'Q&A', 'description' => 'Answers']])
            ->assertOk()
            ->assertJsonPath('data.revision', 2)
            ->assertJsonPath('data.status', 'published')
            ->assertJsonPath('data.title', 'Questions')
            ->assertJsonPath('data.seo.title', 'Q&A')
            ->assertJsonPath('data.seo.share_image', null);
        $this->assertNotNull(StorePage::withoutTenancy()->find($page['id'])->published_at);
        $this->withHeaders($headers)->patchJson($url, ['revision' => 1, 'title' => 'Stale'])
            ->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');

        $this->assertSame(['changes' => ['title', 'status', 'seo.title', 'seo.description']], $this->platformQuery(AuditLog::class)->where('action', 'page.updated')->latest('id')->first()->meta);
        $this->assertTrue($this->platformQuery(AuditLog::class)->where('action', 'page.published')->where('subject_type', 'store_page')->exists());

        // Delete → 204; the footer link stays and resolves as page_missing.
        $this->withHeaders($headers)->deleteJson($url)->assertNoContent();
        $this->withHeaders($headers)->getJson($url)->assertNotFound();
        $footer = collect($this->withHeaders($headers)->getJson("/api/v1/stores/{$store->id}/navigation")->json('data'))->firstWhere('handle', 'footer');
        $this->assertSame('page_missing', end($footer['items'])['link_status']);
        $this->assertNull(end($footer['items'])['href']);
        $this->assertTrue($this->platformQuery(AuditLog::class)->where('action', 'page.deleted')->exists());
    }

    public function test_list_filters_and_search(): void
    {
        [$user, $tenant] = $this->merchant(TenantUser::ROLE_STAFF);
        $store = $this->storeFor($tenant, 'shop');
        $headers = $this->tenantHeaders($user, $tenant);

        $this->withHeaders($headers)->getJson("/api/v1/stores/{$store->id}/pages?filter[status]=published")
            ->assertOk()->assertJsonCount(2, 'data');
        $this->withHeaders($headers)->getJson("/api/v1/stores/{$store->id}/pages?filter[status]=draft,hidden&q=PRIV")
            ->assertOk()->assertJsonCount(1, 'data')->assertJsonPath('data.0.slug', 'privacy')
            ->assertJsonPath('meta.counts.all', 5);
        $this->withHeaders($headers)->getJson("/api/v1/stores/{$store->id}/pages?filter[status]=archived")->assertStatus(422);
        $this->withHeaders($headers)->getJson("/api/v1/stores/{$store->id}/pages?filter[template]=faq")->assertStatus(422);
    }

    public function test_page_limit_is_50(): void
    {
        [$user, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'shop');
        $this->tenancy()->run($tenant, function () use ($store) {
            for ($i = 0; $i < 45; $i++) {
                StorePage::query()->create(['store_id' => $store->id, 'title' => "P{$i}", 'slug' => "p-{$i}"]);
            }
        });

        $this->withHeaders($this->tenantHeaders($user, $tenant))->postJson("/api/v1/stores/{$store->id}/pages", ['title' => 'One too many'])
            ->assertStatus(409)->assertJsonPath('error.code', 'page_limit_reached');
    }

    public function test_body_blocks_validate_and_round_trip(): void
    {
        [$user, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'shop');
        $headers = $this->tenantHeaders($user, $tenant);
        $image = $this->uploadMedia($user, $tenant);

        $body = [
            ['id' => 'aaaaaaaa01', 'type' => 'heading', 'text' => ' Sizes ', 'level' => 2],
            $this->richTextBlock('aaaaaaaa02', [
                ['type' => 'paragraph', 'content' => [['type' => 'text', 'text' => 'Bold ', 'marks' => [['type' => 'bold']]], ['type' => 'hardBreak'], ['type' => 'text', 'text' => 'mail']]],
                ['type' => 'heading', 'attrs' => ['level' => 3], 'content' => [['type' => 'text', 'text' => 'H3']]],
                ['type' => 'bulletList', 'content' => [['type' => 'listItem', 'content' => [['type' => 'paragraph']]]]],
                ['type' => 'blockquote', 'content' => [['type' => 'paragraph', 'content' => [['type' => 'text', 'text' => 'q']]]]],
                $this->linkParagraph('mailto:hello@shop.com'),
                $this->linkParagraph('tel:+8801712345678'),
            ]),
            ['id' => 'aaaaaaaa03', 'type' => 'image', 'media_id' => $image, 'alt' => 'A photo'],
            ['id' => 'aaaaaaaa04', 'type' => 'button', 'label' => 'WhatsApp', 'href' => 'https://wa.me/8801712345678', 'style' => 'primary'],
            ['id' => 'aaaaaaaa05', 'type' => 'callout', 'title' => null, 'items' => ['One'], 'tone' => 'success'],
            ['id' => 'aaaaaaaa06', 'type' => 'table', 'headers' => ['Size', 'Chest'], 'rows' => [['S', '36']]],
        ];

        $this->withHeaders($headers)->postJson("/api/v1/stores/{$store->id}/pages", ['title' => 'Guide', 'body' => $body])
            ->assertCreated()
            ->assertJsonPath('data.body.0.text', 'Sizes')
            ->assertJsonPath('data.body.1.doc.content.0.content.0.text', 'Bold ') // rich text is not trimmed
            ->assertJsonPath('data.body.2.caption', null)
            ->assertJsonPath("data.media.{$image}.id", $image);

        $bad = [
            'body.0.type' => [['id' => 'aaaaaaaa01', 'type' => 'html', 'html' => '<script>']],
            'body.0.id' => [['id' => 'BAD', 'type' => 'heading', 'text' => 'x', 'level' => 2]],
            'body.1.id' => [['id' => 'aaaaaaaa01', 'type' => 'heading', 'text' => 'x', 'level' => 2], ['id' => 'aaaaaaaa01', 'type' => 'heading', 'text' => 'y', 'level' => 3]],
            'body.0.level' => [['id' => 'aaaaaaaa01', 'type' => 'heading', 'text' => 'x', 'level' => 1]],
            'body.0.onclick' => [['id' => 'aaaaaaaa01', 'type' => 'heading', 'text' => 'x', 'level' => 2, 'onclick' => 'x']],
            'body.0.rows.0' => [['id' => 'aaaaaaaa01', 'type' => 'table', 'headers' => ['a', 'b'], 'rows' => [['only one']]]],
            'body.0.items' => [['id' => 'aaaaaaaa01', 'type' => 'callout', 'title' => null, 'items' => [], 'tone' => 'info']],
            'body.0.media_id' => [['id' => 'aaaaaaaa01', 'type' => 'image', 'media_id' => '01jzzzzzzzzzzzzzzzzzzzzzzz', 'alt' => null, 'caption' => null]],
            'body.0.text' => [['id' => 'aaaaaaaa01', 'type' => 'heading', 'text' => "a\u{0007}b", 'level' => 2]],
            'body' => array_fill(0, 41, ['id' => 'aaaaaaaa01', 'type' => 'heading', 'text' => 'x', 'level' => 2]),
        ];
        foreach ($bad as $path => $blocks) {
            $this->withHeaders($headers)->postJson("/api/v1/stores/{$store->id}/pages", ['title' => 'Bad', 'body' => $blocks])
                ->assertStatus(422)->assertJsonStructure(['error' => ['details' => [$path]]]);
        }
    }

    public function test_revalidation_only_when_public_output_changes(): void
    {
        [$user, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'shop');
        $headers = $this->tenantHeaders($user, $tenant);
        Queue::fake();

        $id = $this->withHeaders($headers)->postJson("/api/v1/stores/{$store->id}/pages", ['title' => 'Draft one'])->assertCreated()->json('data.id');
        $this->withHeaders($headers)->patchJson("/api/v1/stores/{$store->id}/pages/{$id}", ['revision' => 1, 'title' => 'Still draft'])->assertOk();
        Queue::assertNotPushed(RevalidateStorefront::class);

        $this->withHeaders($headers)->patchJson("/api/v1/stores/{$store->id}/pages/{$id}", ['revision' => 2, 'status' => 'published'])->assertOk();
        Queue::assertPushed(RevalidateStorefront::class, 1);

        $this->travel(3)->seconds();
        Queue::fake();
        $this->withHeaders($headers)->patchJson("/api/v1/stores/{$store->id}/pages/{$id}", ['revision' => 3, 'status' => 'hidden'])->assertOk();
        Queue::assertPushed(RevalidateStorefront::class, 1); // was published

        $this->travel(3)->seconds();
        Queue::fake();
        $this->withHeaders($headers)->deleteJson("/api/v1/stores/{$store->id}/pages/{$id}")->assertNoContent();
        Queue::assertNotPushed(RevalidateStorefront::class); // hidden page deleted: no public change
    }
}
