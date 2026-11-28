<?php

declare(strict_types=1);

namespace App\Domain\Help\Admin;

use App\Domain\Help\HelpArticleService;
use App\Domain\Help\HelpDb;
use App\Domain\Help\HelpDoc;
use App\Domain\Help\HelpMediaService;
use App\Domain\Help\HelpPresenter;
use App\Domain\Help\HelpViews;
use App\Domain\Help\Models\HelpArticle;
use App\Domain\Help\Models\HelpArticleFeedback;
use App\Domain\Help\Models\HelpArticleTranslation;
use App\Domain\Help\Models\HelpCategory;
use App\Domain\Identity\Models\User;
use App\Domain\Shared\Http\UserRef;
use Illuminate\Support\Collection;

/** Super-admin help shapes (openapi 1.26.0 `admin-help`): drafts AND published state, feedback stats. */
final class AdminHelpPresenter
{
    /** @return array<string, mixed> AdminHelpCategory */
    public static function category(HelpCategory $c, int $published, int $total): array
    {
        return [
            'id' => $c->id,
            'slug' => $c->slug,
            'name_en' => $c->name_en,
            'name_bn' => $c->name_bn,
            'description_en' => $c->description_en,
            'description_bn' => $c->description_bn,
            'icon' => $c->icon,
            'position' => $c->position,
            'article_counts' => ['published' => $published, 'total' => $total],
            'updated_at' => HelpPresenter::ts($c->updated_at),
            'revision' => $c->revision,
        ];
    }

    /**
     * @param  iterable<HelpCategory>  $categories
     * @return list<array<string, mixed>>
     */
    public static function categories(iterable $categories): array
    {
        $rows = HelpDb::query(HelpArticle::class)->groupBy('category_id', 'status')->selectRaw('category_id, status, count(*) as c')->get();
        $out = [];
        foreach ($categories as $c) {
            $mine = $rows->where('category_id', $c->id);
            $out[] = self::category($c, (int) $mine->where('status', HelpArticle::PUBLISHED)->sum('c'), (int) $mine->sum('c'));
        }

        return $out;
    }

    /** @return array<string, mixed>|null AdminHelpTranslation (null = missing or a removed বাংলা draft) */
    public static function translation(?HelpArticleTranslation $t): ?array
    {
        if ($t === null || $t->draft_hash === HelpArticleService::REMOVED_HASH) {
            return null;
        }
        $text = HelpDoc::text($t->body);
        $words = HelpDoc::wordCount(trim($t->title.' '.$text));

        return [
            'language' => $t->language,
            'title' => $t->title,
            'summary' => $t->summary,
            'body' => $t->body,
            'keywords' => array_values($t->keywords ?? []),
            'complete' => HelpArticleService::missing($t) === [],
            'published' => $t->published_hash !== null,
            'has_unpublished_changes' => $t->published_hash === null || $t->hasUnpublishedChanges(),
            'published_at' => HelpPresenter::ts($t->published_at),
            'word_count' => $words,
            'read_minutes' => HelpDoc::readMinutes($words),
        ];
    }

    /** @param Collection<string, HelpArticleTranslation> $translations */
    public static function unpublishedChanges(HelpArticle $a, Collection $translations): bool
    {
        if ($a->status !== HelpArticle::PUBLISHED) {
            return false;
        }
        foreach ($translations as $t) {
            if ($t->draft_hash !== $t->published_hash) {
                return true;
            }
        }

        return false;
    }

    /** @return array<string, mixed> AdminHelpFeedbackSummary */
    public static function feedbackSummary(HelpArticle $a): array
    {
        $since = now()->subDays(30);
        $recent = HelpDb::query(HelpArticleFeedback::class)->where('article_id', $a->id)->where('updated_at', '>=', $since)
            ->selectRaw('sum(case when helpful then 1 else 0 end) as yes, count(*) as total')->first();
        $total = (int) ($recent->total ?? 0);
        $reasons = HelpDb::query(HelpArticleFeedback::class)->where('article_id', $a->id)->where('helpful', false)->whereNotNull('reason')
            ->groupBy('reason')->selectRaw('reason, count(*) as c')->orderByDesc('c')->orderBy('reason')->get()
            ->map(fn ($r) => ['reason' => (string) $r->reason, 'count' => (int) $r->c])->values()->all();

        return [
            'yes' => $a->helpful_yes,
            'no' => $a->helpful_no,
            'helpful_percent_30d' => $total === 0 ? null : (int) round(100 * (int) $recent->yes / $total),
            'votes_30d' => $total,
            'top_reasons' => $reasons,
        ];
    }

    /** @return array<string, mixed> AdminHelpArticle */
    public static function article(HelpArticle $a): array
    {
        $translations = HelpDb::query(HelpArticleTranslation::class)->where('article_id', $a->id)->get(HelpArticleTranslation::COLUMNS)->keyBy('language');
        $relatedIds = array_values((array) $a->related_article_ids);
        $related = $relatedIds === [] ? collect() : HelpDb::query(HelpArticle::class)->whereIn('id', $relatedIds)->get()->keyBy('id');
        $relatedTitles = $relatedIds === [] ? collect() : HelpDb::query(HelpArticleTranslation::class)->whereIn('article_id', $relatedIds)
            ->where('language', 'en')->pluck('title', 'article_id');
        $mediaIds = [];
        foreach ($translations as $t) {
            array_push($mediaIds, ...HelpDoc::mediaIds($t->body), ...HelpDoc::mediaIds($t->published_body));
        }
        $users = User::query()->whereIn('id', array_filter([$a->last_published_by, $a->updated_by]))->get(['id', 'name'])->keyBy('id');

        return [
            'id' => $a->id,
            'slug' => $a->slug,
            'status' => $a->status,
            'scheduled_at' => HelpPresenter::ts($a->scheduled_at),
            'category_id' => $a->category_id,
            'related_article_ids' => $relatedIds,
            'related' => array_values(array_filter(array_map(fn (string $id) => ($r = $related->get($id)) === null ? null : [
                'id' => $r->id, 'slug' => $r->slug, 'title' => (string) ($relatedTitles[$r->id] ?? ''), 'status' => $r->status,
            ], $relatedIds))),
            'translations' => [
                'en' => self::translation($translations->get('en')),
                'bn' => self::translation($translations->get('bn')),
            ],
            'media' => (object) HelpMediaService::refs(array_values(array_unique($mediaIds))),
            'feedback' => self::feedbackSummary($a),
            'views_7d' => HelpViews::lastSevenDays([$a->id])[$a->id] ?? 0,
            'merchant_path' => '/help/articles/'.$a->slug,
            'first_published_at' => HelpPresenter::ts($a->first_published_at),
            'last_published_at' => HelpPresenter::ts($a->last_published_at),
            'last_published_by' => UserRef::of($a->last_published_by !== null ? $users->get($a->last_published_by) : null),
            'archived_at' => HelpPresenter::ts($a->archived_at),
            'created_at' => HelpPresenter::ts($a->created_at),
            'updated_at' => HelpPresenter::ts($a->updated_at),
            'updated_by' => UserRef::of($a->updated_by !== null ? $users->get($a->updated_by) : null),
            'revision' => $a->revision,
        ];
    }

    /**
     * AdminHelpArticleSummary rows.
     *
     * @param  list<HelpArticle>  $articles
     * @return list<array<string, mixed>>
     */
    public static function summaries(array $articles): array
    {
        $ids = array_map(fn (HelpArticle $a) => $a->id, $articles);
        if ($ids === []) {
            return [];
        }
        $translations = HelpDb::query(HelpArticleTranslation::class)->whereIn('article_id', $ids)->get(HelpArticleTranslation::COLUMNS)->groupBy('article_id');
        $categories = HelpDb::query(HelpCategory::class)->whereIn('id', array_unique(array_map(fn (HelpArticle $a) => $a->category_id, $articles)))->get()->keyBy('id');
        $users = User::query()->whereIn('id', array_filter(array_map(fn (HelpArticle $a) => $a->updated_by, $articles)))->get(['id', 'name'])->keyBy('id');
        $views = HelpViews::lastSevenDays($ids);

        return array_map(function (HelpArticle $a) use ($translations, $categories, $users, $views) {
            $t = ($translations->get($a->id) ?? collect())->keyBy('language');
            $en = $t->get('en');
            $votes = $a->helpful_yes + $a->helpful_no;
            $category = $categories->get($a->category_id);

            return [
                'id' => $a->id,
                'slug' => $a->slug,
                'title' => (string) ($en->title ?? ''),
                'category' => ['id' => $a->category_id, 'name' => (string) ($category->name_en ?? '')],
                'languages' => ['en' => self::state($en), 'bn' => self::state($t->get('bn'))],
                'status' => $a->status,
                'scheduled_at' => HelpPresenter::ts($a->scheduled_at),
                'has_unpublished_changes' => self::unpublishedChanges($a, $t),
                'helpful' => ['percent' => $votes === 0 ? null : (int) round(100 * $a->helpful_yes / $votes), 'votes' => $votes],
                'views_7d' => $views[$a->id] ?? 0,
                'updated_at' => HelpPresenter::ts($a->updated_at),
                'updated_by' => UserRef::of($a->updated_by !== null ? $users->get($a->updated_by) : null),
            ];
        }, $articles);
    }

    private static function state(?HelpArticleTranslation $t): string
    {
        return match (true) {
            $t === null, $t->draft_hash === HelpArticleService::REMOVED_HASH => 'missing',
            $t->published_hash !== null => 'published',
            default => 'draft',
        };
    }

    /** @return array<string, mixed> AdminHelpFeedbackEntry */
    public static function feedbackEntry(HelpArticleFeedback $f, ?array $tenant): array
    {
        return [
            'id' => $f->id,
            'helpful' => (bool) $f->helpful,
            'reason' => $f->reason,
            'note' => $f->note,
            'language' => $f->language,
            'tenant' => $tenant,
            'created_at' => HelpPresenter::ts($f->created_at),
            'updated_at' => HelpPresenter::ts($f->updated_at),
        ];
    }
}
