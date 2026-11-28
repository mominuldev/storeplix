<?php

declare(strict_types=1);

namespace Tests\Feature\Help;

use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Help\HelpArticleService;
use App\Domain\Help\Models\HelpArticle;
use App\Domain\Help\Models\HelpArticleTranslation;
use App\Domain\Help\Models\HelpCategory;
use App\Domain\Help\Models\HelpMedia;
use App\Domain\Identity\Models\User;
use App\Domain\Identity\Support\SessionSurface;
use App\Domain\Tenancy\Models\AuditLog;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CatalogFixtures;
use Tests\Support\HelpFixtures;
use Tests\Support\PlatformStaffFixtures;
use Tests\TestCase;

/** PHASE-8-9C §7 help content admin: articles (draft/publish/schedule/…), categories, help images, feedback, authz. */
#[Group('help')]
class AdminHelpContentTest extends TestCase
{
    use CatalogFixtures, HelpFixtures, PlatformStaffFixtures, RefreshDatabase {
        HelpFixtures::assertTenantIsolation insteadof CatalogFixtures;
    }

    private User $staff;

    protected function setUp(): void
    {
        parent::setUp();
        config(['admin.ip_allowlist' => [], 'admin.email_domains' => []]);
        Storage::fake('public');
        $this->withoutMiddleware(ThrottleRequests::class);
        $this->staff = $this->staffUser(PlatformRole::Support);
    }

    private function admin(string $method, string $uri, array $body = [], ?User $as = null): TestResponse
    {
        $this->asAdminSurface();

        return $this->flushHeaders()->withHeaders($this->adminHeaders($as ?? $this->staff))->json($method, '/api/v1/admin'.$uri, $body);
    }

    private function newArticle(string $slug = 'connect-bkash', ?string $category = null): array
    {
        $category ??= $this->admin('POST', '/help-categories', ['slug' => 'payments-'.$slug, 'name_en' => 'Payments', 'icon' => 'card'])->assertCreated()->json('data.id');

        return $this->admin('POST', '/help-articles', ['slug' => $slug, 'category_id' => $category, 'title_en' => 'Connect bKash'])->assertCreated()->json('data');
    }

    private function save(array $a, array $body): TestResponse
    {
        return $this->admin('PATCH', "/help-articles/{$a['id']}", $body + ['revision' => $a['revision']]);
    }

    public function test_create_save_draft_publish_and_unpublished_changes(): void
    {
        $a = $this->newArticle();
        $this->assertSame('draft', $a['status']);
        $this->assertSame(['type' => 'doc', 'content' => []], $a['translations']['en']['body']);
        $this->assertFalse($a['translations']['en']['complete']);
        $this->assertNull($a['translations']['bn']);
        $this->assertSame('/help/articles/connect-bkash', $a['merchant_path']);

        $this->admin('POST', "/help-articles/{$a['id']}/publish", ['revision' => $a['revision']])->assertStatus(422)
            ->assertJsonPath('error.code', 'help_article_incomplete')->assertJsonPath('error.details', ['language' => 'en', 'fields' => ['summary', 'body']]);

        $a = $this->save($a, ['translations' => ['en' => self::helpTranslation('Connect bKash', 'Take bKash payments', null, ['bkash', 'wallet']),
            'bn' => ['title' => 'বিকাশ', 'summary' => '', 'body' => self::helpDoc(), 'keywords' => []]]]);
        $a = $a->assertOk()->json('data');
        $this->assertTrue($a['translations']['en']['complete']);
        $this->admin('POST', "/help-articles/{$a['id']}/publish", ['revision' => $a['revision']])->assertStatus(422)
            ->assertJsonPath('error.details', ['language' => 'bn', 'fields' => ['summary']]);
        $a = $this->save($a, ['translations' => ['bn' => null]])->assertOk()->json('data');
        $this->assertNull($a['translations']['bn']);

        $a = $this->admin('POST', "/help-articles/{$a['id']}/publish", ['revision' => $a['revision']])->assertOk()->json('data');
        $this->assertSame('published', $a['status']);
        $this->assertTrue($a['translations']['en']['published']);
        $this->assertFalse($a['translations']['en']['has_unpublished_changes']);
        $this->assertSame($this->staff->id, $a['last_published_by']['id']);
        $this->assertTrue($this->platformQuery(AuditLog::class)->where('action', 'help_article.published')->whereNull('tenant_id')->exists());

        $a = $this->save($a, ['translations' => ['en' => self::helpTranslation('Connect bKash today', 'Take bKash payments')]])->assertOk()->json('data');
        $this->assertTrue($a['translations']['en']['has_unpublished_changes']);
        $this->assertSame('Connect bKash today', $this->admin('GET', '/help-articles?filter[tab]=published')->json('data.0.title'));
        $this->assertTrue($this->admin('GET', '/help-articles')->json('data.0.has_unpublished_changes'));
        $this->assertSame('Connect bKash', HelpArticleTranslation::query()->where('article_id', $a['id'])->value('published_title'));

        // stale revision → 409; scheduling a live article → 409
        $this->save(['id' => $a['id'], 'revision' => 1], ['slug' => 'x-y'])->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');
        $this->admin('POST', "/help-articles/{$a['id']}/publish", ['revision' => $a['revision'], 'scheduled_at' => now()->addDay()->toIso8601String()])
            ->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
        $this->admin('DELETE', "/help-articles/{$a['id']}")->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
    }

    public function test_doc_validation_errors_are_keyed_by_path(): void
    {
        $a = $this->newArticle();
        $bad = ['type' => 'doc', 'content' => [
            ['type' => 'paragraph', 'content' => [['type' => 'text', 'text' => 'x', 'marks' => [['type' => 'link', 'attrs' => ['href' => 'javascript:alert(1)']]]]]],
            ['type' => 'image', 'attrs' => ['media_id' => strtolower((string) Str::ulid()), 'alt' => '']],
            ['type' => 'iframe'],
        ]];
        $res = $this->save($a, ['translations' => ['en' => self::helpTranslation('T', 'S', $bad)]])->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
        $details = $res->json('error.details');
        $this->assertArrayHasKey('translations.en.body.content.0.content.0.marks.0.attrs.href', $details);
        $this->assertArrayHasKey('translations.en.body.content.1.attrs.media_id', $details);
        $this->assertArrayHasKey('translations.en.body.content.1.attrs.alt', $details);
        $this->assertArrayHasKey('translations.en.body.content.2', $details);
        $this->save($a, ['translations' => ['en' => self::helpTranslation('T', 'S', ['type' => 'doc', 'content' => '<p>hi</p>'])]])->assertStatus(422);
        $this->save($a, ['translations' => ['en' => ['title' => 'T', 'summary' => 'S', 'body' => '<script>alert(1)</script>']]])->assertStatus(422);
        $this->save($a, ['translations' => ['en' => null]])->assertStatus(422);
        $this->save($a, ['slug' => 'Bad Slug'])->assertStatus(422);
        $this->save($a, ['related_article_ids' => [$a['id']]])->assertStatus(422);
    }

    public function test_images_upload_sniffed_platform_path_and_media_missing_on_publish(): void
    {
        $this->admin('POST', '/help-media', [])->assertStatus(422);
        $this->asAdminSurface();
        $svg = UploadedFile::fake()->createWithContent('x.svg', '<svg xmlns="http://www.w3.org/2000/svg"/>');
        $this->flushHeaders()->withHeaders($this->adminHeaders($this->staff))->post('/api/v1/admin/help-media', ['file' => $svg], ['Accept' => 'application/json'])
            ->assertStatus(422)->assertJsonValidationErrors(['file'], 'error.details');
        $small = UploadedFile::fake()->createWithContent('s.png', $this->imageBytes(50, 50));
        $this->flushHeaders()->withHeaders($this->adminHeaders($this->staff))->post('/api/v1/admin/help-media', ['file' => $small], ['Accept' => 'application/json'])->assertStatus(422);
        $png = UploadedFile::fake()->createWithContent('shot.png', $this->imageBytes(1200, 700));
        $ref = $this->flushHeaders()->withHeaders($this->adminHeaders($this->staff))->post('/api/v1/admin/help-media', ['file' => $png, 'alt' => 'Settings'], ['Accept' => 'application/json'])
            ->assertCreated()->json('data');
        $this->assertSame('ready', $ref['status']); // sync queue in tests
        $this->assertArrayHasKey('w640', $ref['variants']);
        $this->assertArrayHasKey('w1024', $ref['variants']);
        $this->assertArrayNotHasKey('w1600', $ref['variants']); // never upscaled
        $media = HelpMedia::query()->findOrFail($ref['id']);
        $this->assertStringStartsWith("platform/help/{$media->id}/", $media->path);
        Storage::disk('public')->assertExists($media->path);

        $a = $this->newArticle();
        $doc = self::helpDoc('Text', [['type' => 'image', 'attrs' => ['media_id' => $ref['id'], 'alt' => 'Settings screen', 'caption' => 'Settings']]]);
        $a = $this->save($a, ['translations' => ['en' => self::helpTranslation('T', 'S', $doc)]])->assertOk()->json('data');
        $this->assertArrayHasKey($ref['id'], $a['media']);
        HelpMedia::query()->whereKey($ref['id'])->update(['status' => 'processing']);
        $this->admin('POST', "/help-articles/{$a['id']}/publish", ['revision' => $a['revision']])->assertStatus(422)
            ->assertJsonPath('error.code', 'help_article_media_missing')->assertJsonPath('error.details.media_ids', [$ref['id']]);
        HelpMedia::query()->whereKey($ref['id'])->update(['status' => 'ready']);
        $this->admin('POST', "/help-articles/{$a['id']}/publish", ['revision' => $a['revision']])->assertOk();

        // prune keeps referenced images, removes old unreferenced ones
        $orphan = $this->flushHeaders()->withHeaders($this->adminHeaders($this->staff))->post('/api/v1/admin/help-media', ['file' => UploadedFile::fake()->createWithContent('o.png', $this->imageBytes(400, 400))], ['Accept' => 'application/json'])->json('data.id');
        $this->travel(8)->days();
        $this->artisan('help:prune-media')->assertSuccessful();
        $this->assertTrue(HelpMedia::query()->whereKey($ref['id'])->exists());
        $this->assertFalse(HelpMedia::query()->whereKey($orphan)->exists());
    }

    public function test_schedule_unpublish_archive_restore_delete_and_slug_rules(): void
    {
        $a = $this->newArticle();
        $a = $this->save($a, ['translations' => ['en' => self::helpTranslation('Guide')]])->json('data');
        $this->admin('POST', "/help-articles/{$a['id']}/publish", ['revision' => $a['revision'], 'scheduled_at' => now()->addMinute()->toIso8601String()])->assertStatus(422);
        $this->admin('POST', "/help-articles/{$a['id']}/publish", ['revision' => $a['revision'], 'scheduled_at' => now()->addYears(2)->toIso8601String()])->assertStatus(422);
        $a = $this->admin('POST', "/help-articles/{$a['id']}/publish", ['revision' => $a['revision'], 'scheduled_at' => now()->addHour()->toIso8601String()])
            ->assertOk()->assertJsonPath('status', null)->json('data');
        $this->assertSame('scheduled', $a['status']);
        $this->assertSame(1, $this->admin('GET', '/help-articles?filter[tab]=scheduled')->json('meta.counts.scheduled'));
        $a = $this->admin('POST', "/help-articles/{$a['id']}/unpublish")->assertOk()->json('data');
        $this->assertSame(['draft', null], [$a['status'], $a['scheduled_at']]);
        $this->admin('POST', "/help-articles/{$a['id']}/unpublish")->assertStatus(409);
        $a = $this->admin('POST', "/help-articles/{$a['id']}/archive", ['reason' => 'Old'])->assertOk()->json('data');
        $this->assertSame('archived', $a['status']);
        $this->admin('POST', "/help-articles/{$a['id']}/publish", ['revision' => $a['revision']])->assertStatus(409);
        $this->assertSame(1, $this->admin('GET', '/help-articles')->json('meta.counts.archived'));
        $this->assertSame(0, $this->admin('GET', '/help-articles')->json('meta.counts.all'));
        $a = $this->admin('POST', "/help-articles/{$a['id']}/restore")->assertOk()->json('data');
        $this->assertSame('draft', $a['status']);

        $b = $this->newArticle('second');
        $this->save($b, ['slug' => 'connect-bkash'])->assertStatus(409)->assertJsonPath('error.code', 'help_slug_taken');
        $this->admin('POST', '/help-articles', ['slug' => 'second', 'category_id' => $b['category_id'], 'title_en' => 'X'])->assertStatus(409);
        $this->admin('POST', '/help-articles', ['slug' => 'third', 'category_id' => strtolower((string) Str::ulid()), 'title_en' => 'X'])
            ->assertStatus(422)->assertJsonValidationErrors(['category_id'], 'error.details');

        $this->admin('DELETE', "/help-articles/{$a['id']}")->assertNoContent();
        $this->assertFalse(HelpArticle::query()->whereKey($a['id'])->exists());
        $this->assertTrue($this->platformQuery(AuditLog::class)->where('action', 'help_article.deleted')->exists());

        // a slug used by a redirect is taken
        $c = $this->newArticle('third');
        $c = $this->save($c, ['translations' => ['en' => self::helpTranslation('Third')]])->json('data');
        $c = $this->admin('POST', "/help-articles/{$c['id']}/publish", ['revision' => $c['revision']])->json('data');
        $this->save($c, ['slug' => 'third-renamed'])->assertOk();
        $this->save($b, ['slug' => 'third'])->assertStatus(409)->assertJsonPath('error.code', 'help_slug_taken');
        $this->admin('GET', '/help-articles/'.strtolower((string) Str::ulid()))->assertNotFound();
    }

    public function test_list_filters_sort_missing_bn_stats_and_feedback(): void
    {
        [, $tenant, , $h] = $this->shop();
        $topic = $this->helpCategory('t1', 'Topic one');
        $en = $this->helpPublished($topic, 'english-only', 'Alpha english', null, self::helpTranslation('Alpha english', 'S', null, ['courier']));
        $both = $this->helpPublished($topic, 'both', 'Beta both', self::helpTranslation('বিটা', 'সারাংশ'));
        $this->helpDraft($this->helpCategory('t2', 'Topic two'), 'drafted', 'Gamma draft');
        $this->flushHeaders()->withHeaders($h)->putJson('/api/v1/help/articles/both/feedback', ['helpful' => false, 'language' => 'en', 'reason' => 'hard_to_follow', 'note' => 'Too long'])->assertOk();

        $res = $this->admin('GET', '/help-articles?sort=title')->assertOk();
        $this->assertSame(['Alpha english', 'Beta both', 'Gamma draft'], array_column($res->json('data'), 'title'));
        $res->assertJsonPath('meta.counts', ['all' => 3, 'published' => 2, 'draft' => 1, 'scheduled' => 0, 'archived' => 0, 'missing_bn' => 1])
            ->assertJsonPath('meta.stats', ['published' => 2, 'drafts' => 1, 'missing_bn' => 1, 'helpful_percent_30d' => 0]);
        $this->assertSame([$en->id], array_column($this->admin('GET', '/help-articles?filter[tab]=missing_bn')->json('data'), 'id'));
        $this->assertSame([$both->id], array_column($this->admin('GET', '/help-articles?filter[language]=bn')->json('data'), 'id'));
        $this->assertSame([$en->id], array_column($this->admin('GET', '/help-articles?filter[q]=courier')->json('data'), 'id'));
        $this->assertSame([$en->id], array_column($this->admin('GET', '/help-articles?filter[q]=english-o')->json('data'), 'id'));
        $this->assertSame(2, count($this->admin('GET', "/help-articles?filter[category]={$topic->id}")->json('data')));
        $this->assertSame($both->id, $this->admin('GET', '/help-articles?sort=helpful')->json('data.0.id')); // voted guides first, unvoted last
        $this->admin('GET', '/help-articles?sort=views')->assertOk();
        $this->assertSame(['en' => 'published', 'bn' => 'published'], $this->admin('GET', '/help-articles?filter[q]=beta')->json('data.0.languages'));
        $this->assertSame(['en' => 'published', 'bn' => 'missing'], $this->admin('GET', '/help-articles?filter[q]=alpha')->json('data.0.languages'));

        $fb = $this->admin('GET', "/help-articles/{$both->id}/feedback?filter[helpful]=0")->assertOk();
        $fb->assertJsonPath('data.0.reason', 'hard_to_follow')->assertJsonPath('data.0.note', 'Too long')->assertJsonPath('data.0.tenant.id', $tenant->id);
        $this->admin('GET', "/help-articles/{$both->id}")->assertOk()->assertJsonPath('data.feedback.no', 1)
            ->assertJsonPath('data.feedback.top_reasons.0', ['reason' => 'hard_to_follow', 'count' => 1])->assertJsonPath('data.feedback.helpful_percent_30d', 0);
    }

    public function test_categories_crud_reorder_not_empty_and_limit(): void
    {
        $a = $this->admin('POST', '/help-categories', ['slug' => 'orders', 'name_en' => 'Orders', 'name_bn' => 'অর্ডার', 'icon' => 'cart'])->assertCreated()->json('data');
        $this->admin('POST', '/help-categories', ['slug' => 'orders', 'name_en' => 'Again', 'icon' => 'cart'])->assertStatus(409)->assertJsonPath('error.code', 'help_category_slug_taken');
        $this->admin('POST', '/help-categories', ['slug' => 'svg', 'name_en' => 'Bad', 'icon' => '<svg>'])->assertStatus(422);
        $b = $this->admin('POST', '/help-categories', ['slug' => 'shipping', 'name_en' => 'Shipping', 'icon' => 'truck'])->assertCreated()->json('data');
        $this->admin('PATCH', "/help-categories/{$a['id']}", ['revision' => 99, 'name_en' => 'X'])->assertStatus(409);
        $this->admin('PATCH', "/help-categories/{$a['id']}", ['revision' => $a['revision'], 'name_en' => 'Orders & returns'])->assertOk()->assertJsonPath('data.name_en', 'Orders & returns');
        $this->admin('PATCH', "/help-categories/{$b['id']}", ['revision' => $b['revision'], 'slug' => 'orders'])->assertStatus(409);
        $this->assertSame([$b['id'], $a['id']], array_column($this->admin('POST', '/help-categories/reorder', ['ids' => [$b['id'], $a['id']]])->assertOk()->json('data'), 'id'));
        $this->admin('POST', '/help-categories/reorder', ['ids' => [$b['id']]])->assertStatus(422);

        $this->admin('POST', '/help-articles', ['slug' => 'in-orders', 'category_id' => $a['id'], 'title_en' => 'In orders'])->assertCreated();
        $this->admin('DELETE', "/help-categories/{$a['id']}")->assertStatus(409)->assertJsonPath('error.code', 'help_category_not_empty');
        $this->assertSame(1, $this->admin('GET', '/help-categories')->json('data.1.article_counts.total'));
        $this->admin('DELETE', "/help-categories/{$b['id']}")->assertNoContent();

        for ($i = HelpCategory::query()->count(); $i < HelpCategory::MAX; $i++) {
            $this->admin('POST', '/help-categories', ['slug' => "c{$i}", 'name_en' => "C{$i}", 'icon' => 'box'])->assertCreated();
        }
        $this->admin('POST', '/help-categories', ['slug' => 'one-more', 'name_en' => 'More', 'icon' => 'box'])->assertStatus(422)->assertJsonPath('error.code', 'help_category_limit_reached');
        $this->assertTrue($this->platformQuery(AuditLog::class)->where('action', 'help_category.deleted')->exists());
    }

    public function test_scheduled_job_publishes_due_articles_and_flags_incomplete_ones_once(): void
    {
        $topic = $this->helpCategory();
        $due = $this->helpDraft($topic, 'due', 'Due');
        $broken = $this->helpDraft($topic, 'broken', 'Broken');
        $service = app(HelpArticleService::class);
        $service->publish($due->id, $this->helpAuthor(), $due->revision, now()->addMinutes(10));
        $service->publish($broken->id, $this->helpAuthor(), $broken->revision, now()->addMinutes(10));
        $broken = $service->find($broken->id);
        $service->update($broken->id, $this->helpAuthor(), ['revision' => $broken->revision, 'translations' => ['en' => self::helpTranslation('Broken', '')]]);

        $this->artisan('help:publish-scheduled')->assertSuccessful();
        $this->assertSame('scheduled', $service->find($due->id)->status);
        $this->travel(11)->minutes();
        $this->artisan('help:publish-scheduled')->assertSuccessful();
        $this->artisan('help:publish-scheduled')->assertSuccessful();
        $this->assertSame('published', $service->find($due->id)->status);
        $this->assertNull($service->find($due->id)->last_published_by);
        $this->assertSame('scheduled', $service->find($broken->id)->status);
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('action', 'help_article.schedule_failed')->count());
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('action', 'help_article.published')->where('actor_type', 'system')->count());
    }

    public function test_only_manage_help_content_roles_and_never_merchant_sessions(): void
    {
        foreach ([PlatformRole::Billing, PlatformRole::ReadOnly] as $role) {
            $this->admin('GET', '/help-articles', [], $this->staffUser($role))->assertForbidden()->assertJsonPath('error.code', 'forbidden');
            $this->admin('POST', '/help-categories', ['slug' => 'x', 'name_en' => 'X', 'icon' => 'box'], $this->staffUser($role))->assertForbidden();
        }
        $this->admin('GET', '/help-articles', [], $this->staffUser(PlatformRole::SuperAdmin))->assertOk();
        [$merchant, $tenant] = $this->merchant();
        $this->flushHeaders()->withHeaders($this->tenantHeaders($merchant, $tenant) + ['Accept' => 'application/json'])->getJson('/api/v1/admin/help-articles')->assertForbidden();
        $this->asAdminSurface(SessionSurface::MERCHANT);
        $this->flushHeaders()->withHeaders($this->adminHeaders($this->staff))->getJson('/api/v1/admin/help-categories')->assertForbidden();
        $this->flushHeaders();
        $this->app['auth']->forgetGuards();
        $this->withHeaders(['Referer' => self::ADMIN_ORIGIN.'/'])->getJson('/api/v1/admin/help-articles')->assertUnauthorized();
    }
}
