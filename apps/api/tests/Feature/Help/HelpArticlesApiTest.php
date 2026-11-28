<?php

declare(strict_types=1);

namespace Tests\Feature\Help;

use App\Domain\Help\HelpArticleService;
use App\Domain\Help\Models\HelpArticle;
use App\Domain\Help\Models\HelpArticleFeedback;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\DB;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CatalogFixtures;
use Tests\Support\HelpFixtures;
use Tests\Support\PlatformStaffFixtures;
use Tests\Support\RoleFixtures;
use Tests\TestCase;

/** PHASE-8-9C §4–§6 merchant guides: home, topics, article (fallback, TOC, related, redirects), search, feedback, views. */
#[Group('help')]
class HelpArticlesApiTest extends TestCase
{
    use CatalogFixtures, HelpFixtures, PlatformStaffFixtures, RefreshDatabase, RoleFixtures {
        HelpFixtures::assertTenantIsolation insteadof CatalogFixtures;
    }

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutMiddleware(ThrottleRequests::class);
    }

    public function test_home_lists_topics_with_published_guides_popular_and_contact_gating(): void
    {
        [, $tenant, , $h] = $this->shop();
        $topic = $this->helpCategory('payments', 'Payments', 'পেমেন্ট');
        $this->helpCategory('empty-topic', 'Empty');
        $a = $this->helpPublished($topic, 'connect-bkash', 'Connect bKash');
        $this->helpDraft($topic, 'draft-guide', 'Draft guide');

        $res = $this->api($h, 'GET', '/api/v1/help/home?language=bn')->assertOk();
        $this->assertSame(['payments'], array_column($res->json('data.categories'), 'slug'));
        $res->assertJsonPath('data.categories.0.name', 'পেমেন্ট')->assertJsonPath('data.categories.0.article_count', 1)
            ->assertJsonPath('data.total_articles', 1)->assertJsonPath('data.can_contact_support', true)
            ->assertJsonPath('data.popular.0.id', $a->id)->assertJsonPath('data.popular.0.language', 'en');

        [, $staffH] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $this->api($staffH, 'GET', '/api/v1/help/home')->assertOk()->assertJsonPath('data.can_contact_support', false);
        $this->api($h, 'GET', '/api/v1/help/home?language=fr')->assertStatus(422);
    }

    public function test_custom_role_without_keys_reads_guides(): void
    {
        [, $tenant, , $h] = $this->growthShop();
        $role = $this->customRole($h, 'Nothing', []);
        [, $mh] = $this->memberWithRole($tenant, $role);
        $topic = $this->helpCategory();
        $this->helpPublished($topic, 'hello', 'Hello');
        $this->api($mh, 'GET', '/api/v1/help/articles/hello')->assertOk();
        $this->api($mh, 'PUT', '/api/v1/help/articles/hello/feedback', ['helpful' => true, 'language' => 'en'])->assertOk();
        $this->api($mh, 'GET', '/api/v1/help/tickets')->assertForbidden();
    }

    public function test_category_page_orders_by_title_and_hides_empty_topics(): void
    {
        [, , , $h] = $this->shop();
        $topic = $this->helpCategory('orders', 'Orders');
        $this->helpPublished($topic, 'zeta', 'Zeta guide');
        $this->helpPublished($topic, 'alpha', 'Alpha guide');
        $empty = $this->helpCategory('nothing', 'Nothing');
        $this->helpDraft($empty, 'hidden', 'Hidden');

        $this->api($h, 'GET', '/api/v1/help/categories/orders')->assertOk()
            ->assertJsonPath('data.category.article_count', 2)->assertJsonPath('data.articles.0.slug', 'alpha')->assertJsonPath('data.articles.1.slug', 'zeta');
        $this->api($h, 'GET', '/api/v1/help/categories/nothing')->assertNotFound()->assertJsonPath('error.code', 'help_category_not_found');
        $this->api($h, 'GET', '/api/v1/help/categories/missing')->assertNotFound()->assertJsonPath('error.code', 'help_category_not_found');
        $this->assertSame(['orders'], array_column($this->api($h, 'GET', '/api/v1/help/categories')->assertOk()->json('data'), 'slug'));
    }

    public function test_article_serves_published_snapshot_with_fallback_toc_and_vote(): void
    {
        [, , , $h] = $this->shop();
        $topic = $this->helpCategory();
        $article = $this->helpPublished($topic, 'set-up-delivery', 'Set up delivery');

        $res = $this->api($h, 'GET', '/api/v1/help/articles/set-up-delivery?language=bn')->assertOk();
        $res->assertJsonPath('data.language', 'en')->assertJsonPath('data.requested_language', 'bn')->assertJsonPath('data.fallback', true)
            ->assertJsonPath('data.available_languages', ['en'])->assertJsonPath('data.title', 'Set up delivery')
            ->assertJsonPath('data.toc.0', ['id' => '0-first-steps', 'text' => 'First steps', 'level' => 2])
            ->assertJsonPath('data.helpful.my_vote', null)->assertJsonPath('data.read_minutes', 1);

        // editing the draft never changes what merchants read until Publish (P89C-4)
        $service = app(HelpArticleService::class);
        $row = $service->find($article->id);
        $service->update($row->id, $this->helpAuthor(), ['revision' => $row->revision, 'translations' => [
            'en' => self::helpTranslation('Changed title'),
            'bn' => self::helpTranslation('ডেলিভারি সেট করুন', 'সংক্ষেপ'),
        ]]);
        $this->api($h, 'GET', '/api/v1/help/articles/set-up-delivery?language=bn')->assertOk()->assertJsonPath('data.title', 'Set up delivery')
            ->assertJsonPath('data.fallback', true);
        $row = $service->find($article->id);
        $service->publish($row->id, $this->helpAuthor(), $row->revision, null);
        $this->api($h, 'GET', '/api/v1/help/articles/set-up-delivery?language=bn')->assertOk()->assertJsonPath('data.title', 'ডেলিভারি সেট করুন')
            ->assertJsonPath('data.fallback', false)->assertJsonPath('data.available_languages', ['en', 'bn']);
        $this->api($h, 'GET', '/api/v1/help/articles/set-up-delivery')->assertOk()->assertJsonPath('data.title', 'Changed title');
    }

    /** The shared renderer gives the n-th H2/H3 the id toc[n].id: one entry per heading, document order, none skipped. */
    public function test_toc_has_one_entry_per_heading_in_document_order(): void
    {
        [, , , $h] = $this->shop();
        $doc = ['type' => 'doc', 'content' => [
            ['type' => 'heading', 'attrs' => ['level' => 2], 'content' => [['type' => 'text', 'text' => 'Before you start']]],
            ['type' => 'paragraph', 'content' => [['type' => 'text', 'text' => 'Intro']]],
            ['type' => 'heading', 'attrs' => ['level' => 3], 'content' => [['type' => 'text', 'text' => 'Step one!']]],
            ['type' => 'heading', 'attrs' => ['level' => 2]],
            ['type' => 'callout', 'attrs' => ['tone' => 'tip'], 'content' => [['type' => 'paragraph', 'content' => [['type' => 'text', 'text' => 'Tip']]]]],
            ['type' => 'heading', 'attrs' => ['level' => 2], 'content' => [['type' => 'text', 'text' => 'Before you start']]],
        ]];
        $this->helpPublished($this->helpCategory(), 'toc-guide', 'TOC guide', null, self::helpTranslation('TOC guide', 'Summary', $doc));

        $toc = $this->api($h, 'GET', '/api/v1/help/articles/toc-guide')->assertOk()->json('data.toc');
        $this->assertSame([
            ['id' => '0-before-you-start', 'text' => 'Before you start', 'level' => 2],
            ['id' => '2-step-one', 'text' => 'Step one!', 'level' => 3],
            ['id' => '3', 'text' => '', 'level' => 2],
            ['id' => '5-before-you-start', 'text' => 'Before you start', 'level' => 2],
        ], $toc);
        $this->assertCount(4, array_unique(array_column($toc, 'id')));
    }

    public function test_draft_scheduled_and_archived_guides_are_404_everywhere(): void
    {
        [, , , $h] = $this->shop();
        $topic = $this->helpCategory();
        $live = $this->helpPublished($topic, 'live', 'Live guide words');
        $draft = $this->helpDraft($topic, 'drafty', 'Drafty guide words');
        $scheduled = $this->helpDraft($topic, 'later', 'Later guide words');
        app(HelpArticleService::class)->publish($scheduled->id, $this->helpAuthor(), $scheduled->revision, now()->addHour());
        $archived = $this->helpPublished($topic, 'old', 'Old guide words');
        app(HelpArticleService::class)->archive($archived->id, $this->helpAuthor(), 'outdated');
        $live = app(HelpArticleService::class)->find($live->id);
        app(HelpArticleService::class)->update($live->id, $this->helpAuthor(), ['revision' => $live->revision, 'related_article_ids' => [$draft->id, $archived->id]]);

        foreach (['drafty', 'later', 'old'] as $slug) {
            $this->api($h, 'GET', "/api/v1/help/articles/{$slug}")->assertNotFound()->assertJsonPath('error.code', 'help_article_not_found');
            $this->api($h, 'PUT', "/api/v1/help/articles/{$slug}/feedback", ['helpful' => true, 'language' => 'en'])->assertNotFound();
        }
        $this->assertSame(['live'], array_column($this->api($h, 'GET', '/api/v1/help/articles?q=guide')->assertOk()->json('data'), 'slug'));
        $this->assertSame([], $this->api($h, 'GET', '/api/v1/help/articles/live')->assertOk()->json('data.related'));
        $this->assertSame(['live'], array_column($this->api($h, 'GET', '/api/v1/help/home')->json('data.popular'), 'slug'));
    }

    public function test_slug_change_of_a_live_guide_redirects(): void
    {
        [, , , $h] = $this->shop();
        $a = $this->helpPublished($this->helpCategory(), 'old-name', 'Guide');
        $a = app(HelpArticleService::class)->find($a->id);
        app(HelpArticleService::class)->update($a->id, $this->helpAuthor(), ['revision' => $a->revision, 'slug' => 'new-name']);

        $this->api($h, 'GET', '/api/v1/help/articles/old-name')->assertOk()->assertJsonPath('data.slug', 'new-name');
        $this->api($h, 'GET', '/api/v1/help/articles/new-name')->assertOk()->assertJsonPath('data.slug', 'new-name');
    }

    public function test_related_picks_then_top_up_from_the_same_topic(): void
    {
        [, , , $h] = $this->shop();
        $topic = $this->helpCategory();
        $other = $this->helpCategory('other', 'Other');
        $main = $this->helpPublished($topic, 'main', 'Main');
        $pick = $this->helpPublished($other, 'pick', 'Pick');
        $same1 = $this->helpPublished($topic, 'same-one', 'Same one');
        $this->helpPublished($topic, 'same-two', 'Same two');
        $main = app(HelpArticleService::class)->find($main->id);
        app(HelpArticleService::class)->update($main->id, $this->helpAuthor(), ['revision' => $main->revision, 'related_article_ids' => [$pick->id]]);

        $related = $this->api($h, 'GET', '/api/v1/help/articles/main')->assertOk()->json('data.related');
        $this->assertCount(3, $related);
        $this->assertSame('pick', $related[0]['slug']);
        $this->assertEqualsCanonicalizing(['same-one', 'same-two'], [$related[1]['slug'], $related[2]['slug']]);
        $this->assertNotContains($same1->id === $main->id ? 'x' : 'main', array_column($related, 'slug'));
    }

    public function test_search_english_bangla_language_filter_category_counts_and_pagination(): void
    {
        [, , , $h] = $this->shop();
        $payments = $this->helpCategory('payments', 'Payments');
        $shipping = $this->helpCategory('shipping', 'Shipping');
        $this->helpPublished($payments, 'bkash', 'Connect bKash payments', self::helpTranslation('বিকাশ সংযোগ করুন', 'বিকাশ পেমেন্ট চালু', self::helpDoc('সেটিংসে যান এবং বিকাশ বেছে নিন।')));
        $this->helpPublished($shipping, 'pathao', 'Book Pathao courier', null, self::helpTranslation('Book Pathao courier', 'Courier booking', self::helpDoc('Payments are collected on delivery.'), ['cod']));

        $res = $this->api($h, 'GET', '/api/v1/help/articles?q=payments')->assertOk();
        $this->assertSame(2, $res->json('meta.total'));
        $this->assertSame('bkash', $res->json('data.0.slug')); // title hit ranks first
        $this->assertSame('payments', $res->json('meta.query'));
        $this->assertEqualsCanonicalizing([['payments', 1], ['shipping', 1]], array_map(fn ($c) => [$c['category']['slug'], $c['count']], $res->json('meta.counts_by_category')));

        $this->api($h, 'GET', '/api/v1/help/articles?q='.urlencode('বিকাশ'))->assertOk()->assertJsonPath('meta.total', 1)
            ->assertJsonPath('data.0.language', 'bn')->assertJsonPath('data.0.title', 'বিকাশ সংযোগ করুন');
        $this->api($h, 'GET', '/api/v1/help/articles?q=payments&language=bn')->assertOk()->assertJsonPath('meta.total', 0);
        $this->api($h, 'GET', '/api/v1/help/articles?q=payments&category=shipping')->assertOk()->assertJsonPath('meta.total', 1)
            ->assertJsonPath('data.0.slug', 'pathao')->assertJsonCount(2, 'meta.counts_by_category');
        $this->api($h, 'GET', '/api/v1/help/articles?q=cod')->assertOk()->assertJsonPath('meta.total', 1);
        $page = $this->api($h, 'GET', '/api/v1/help/articles?q=payments&per_page=1&page=2')->assertOk();
        $page->assertJsonCount(1, 'data')->assertJsonPath('meta.last_page', 2)->assertJsonPath('meta.current_page', 2);
        $this->assertStringNotContainsString('<', (string) $page->json('data.0.snippet'));
    }

    public function test_search_validation_and_injection_strings_are_literal(): void
    {
        [, , , $h] = $this->shop();
        $this->helpPublished($this->helpCategory(), 'guide', 'A guide');
        $this->api($h, 'GET', '/api/v1/help/articles')->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');
        $this->api($h, 'GET', '/api/v1/help/articles?q=a')->assertStatus(422);
        $this->api($h, 'GET', '/api/v1/help/articles?q='.str_repeat('x', 101))->assertStatus(422);
        foreach (['%%', '__', "' OR 1=1 --", 'guide\'); DROP TABLE help_articles; --', '!:*&|'] as $q) {
            $this->api($h, 'GET', '/api/v1/help/articles?q='.urlencode($q))->assertOk()->assertJsonPath('meta.total', 0);
        }
        $this->assertSame(1, HelpArticle::query()->count());
    }

    public function test_feedback_upsert_change_undo_and_counters(): void
    {
        [, $tenant, , $h] = $this->shop();
        [, $h2] = $this->member($tenant, TenantUser::ROLE_ADMIN);
        $a = $this->helpPublished($this->helpCategory(), 'vote-me', 'Vote me');
        $url = '/api/v1/help/articles/vote-me/feedback';

        $this->api($h, 'PUT', $url, ['helpful' => false, 'language' => 'en', 'reason' => 'out_of_date', 'note' => " The screen\x07 changed "])->assertOk()
            ->assertJsonPath('data.helpful', false)->assertJsonPath('data.reason', 'out_of_date')->assertJsonPath('data.note', 'The screen changed');
        $this->api($h2, 'PUT', $url, ['helpful' => true, 'language' => 'bn'])->assertOk();
        $this->assertCounters($a->id, 1, 1);
        $this->api($h, 'PUT', $url, ['helpful' => true, 'language' => 'en'])->assertOk()->assertJsonPath('data.reason', null);
        $this->assertCounters($a->id, 2, 0);
        $this->assertSame(2, HelpArticleFeedback::query()->where('article_id', $a->id)->count());
        $this->api($h, 'GET', '/api/v1/help/articles/vote-me')->assertJsonPath('data.helpful.yes_count', 2)->assertJsonPath('data.helpful.my_vote.helpful', true);

        $this->api($h, 'DELETE', $url)->assertNoContent();
        $this->api($h, 'DELETE', $url)->assertNoContent();
        $this->assertCounters($a->id, 1, 0);
        $this->assertSame($tenant->id, HelpArticleFeedback::query()->value('tenant_id'));

        // validation: reason only on No, known reasons, note ≤ 500, language required
        $this->api($h, 'PUT', $url, ['helpful' => true, 'language' => 'en', 'reason' => 'out_of_date'])->assertStatus(422);
        $this->api($h, 'PUT', $url, ['helpful' => false, 'language' => 'en', 'reason' => 'nope'])->assertStatus(422);
        $this->api($h, 'PUT', $url, ['helpful' => false, 'language' => 'en', 'note' => str_repeat('x', 501)])->assertStatus(422);
        $this->api($h, 'PUT', $url, ['helpful' => false])->assertStatus(422);
    }

    public function test_views_are_counted_once_per_member_per_day(): void
    {
        [, $tenant, , $h] = $this->shop();
        [, $h2] = $this->member($tenant, TenantUser::ROLE_ADMIN);
        $a = $this->helpPublished($this->helpCategory(), 'viewed', 'Viewed');
        $b = $this->helpPublished($this->helpCategory('two', 'Two'), 'newer', 'Newer');
        $this->api($h, 'GET', '/api/v1/help/articles/viewed')->assertOk();
        $this->api($h, 'GET', '/api/v1/help/articles/viewed')->assertOk();
        $this->api($h2, 'GET', '/api/v1/help/articles/viewed')->assertOk();
        $this->assertSame(2, (int) DB::table('help_article_daily_views')->where('article_id', $a->id)->sum('views'));
        // popular: most viewed first even though `newer` was published later
        $this->assertSame([$a->id, $b->id], array_column($this->api($h, 'GET', '/api/v1/help/home')->json('data.popular'), 'id'));
    }

    private function assertCounters(string $id, int $yes, int $no): void
    {
        $row = HelpArticle::query()->findOrFail($id);
        $this->assertSame([$yes, $no], [$row->helpful_yes, $row->helpful_no]);
        $this->assertSame($yes, HelpArticleFeedback::query()->where('article_id', $id)->where('helpful', true)->count());
        $this->assertSame($no, HelpArticleFeedback::query()->where('article_id', $id)->where('helpful', false)->count());
    }
}
