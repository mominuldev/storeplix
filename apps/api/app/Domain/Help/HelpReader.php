<?php

declare(strict_types=1);

namespace App\Domain\Help;

use App\Domain\Help\Models\HelpArticle;
use App\Domain\Help\Models\HelpArticleFeedback;
use App\Domain\Help\Models\HelpArticleRedirect;
use App\Domain\Help\Models\HelpArticleTranslation;
use App\Domain\Help\Models\HelpCategory;
use App\Domain\Shared\Http\ApiException;
use Illuminate\Support\Collection;

/**
 * Merchant reads (PHASE-8-9C §4–§5, S253): only `published` articles and their published snapshots, categories with at
 * least one published article. Names and titles in the requested language with English fallback per item.
 */
final class HelpReader
{
    public const POPULAR = 8;

    /** @return Collection<int, HelpArticle> published articles, newest first */
    public function published(?string $categoryId = null): Collection
    {
        return HelpArticle::query()->where('status', HelpArticle::PUBLISHED)
            ->when($categoryId !== null, fn ($q) => $q->where('category_id', $categoryId))
            ->orderByDesc('last_published_at')->orderByDesc('id')->get();
    }

    /**
     * Published snapshots by article id and language.
     *
     * @param  list<string>  $articleIds
     * @return array<string, array<string, HelpArticleTranslation>>
     */
    public function snapshots(array $articleIds): array
    {
        if ($articleIds === []) {
            return [];
        }
        $out = [];
        $columns = ['id', 'article_id', 'language', 'published_title', 'published_summary', 'published_at', 'read_minutes', 'published_hash'];
        foreach (HelpArticleTranslation::query()->whereIn('article_id', $articleIds)->whereNotNull('published_hash')->get($columns) as $t) {
            $out[$t->article_id][$t->language] = $t;
        }

        return $out;
    }

    /** @return list<array<string, mixed>> HelpCategory[] with ≥ 1 published article, ordered */
    public function categories(string $language): array
    {
        $counts = HelpArticle::query()->where('status', HelpArticle::PUBLISHED)->groupBy('category_id')
            ->selectRaw('category_id, count(*) as c')->pluck('c', 'category_id');
        $out = [];
        foreach (HelpCategory::query()->orderBy('position')->orderBy('name_en')->get() as $c) {
            $n = (int) ($counts[$c->id] ?? 0);
            if ($n > 0) {
                $out[] = HelpPresenter::category($c, $language, $n);
            }
        }

        return $out;
    }

    /** @return array{0: HelpCategory, 1: int} */
    public function category(string $slug): array
    {
        $category = preg_match('/^[a-z0-9-]{1,60}$/', $slug) === 1 ? HelpCategory::query()->where('slug', $slug)->first() : null;
        $count = $category === null ? 0 : HelpArticle::query()->where('status', HelpArticle::PUBLISHED)->where('category_id', $category->id)->count();
        if ($category === null || $count === 0) {
            throw new ApiException(404, 'help_category_not_found', 'This topic does not exist.');
        }

        return [$category, $count];
    }

    /**
     * A published article by slug or redirected slug, else 404 `help_article_not_found` (draft, scheduled, archived).
     */
    public function article(string $slug): HelpArticle
    {
        $slug = strtolower($slug);
        $article = null;
        if (preg_match('/^[a-z0-9-]{1,80}$/', $slug) === 1) {
            $article = HelpArticle::query()->where('slug', $slug)->first();
            if ($article === null && ($redirect = HelpArticleRedirect::query()->find($slug)) !== null) {
                $article = HelpArticle::query()->find($redirect->article_id);
            }
        }
        if (! $article instanceof HelpArticle || $article->status !== HelpArticle::PUBLISHED) {
            throw new ApiException(404, 'help_article_not_found', 'This guide was moved or unpublished.');
        }

        return $article;
    }

    /**
     * HelpArticleLink[] for the given articles (in order), skipping any without a published English snapshot.
     *
     * @param  iterable<HelpArticle>  $articles
     * @return list<array<string, mixed>>
     */
    public function links(iterable $articles, string $language): array
    {
        $articles = collect($articles)->values();
        $snapshots = $this->snapshots($articles->pluck('id')->all());
        $categories = HelpSearch::categories($articles->pluck('category_id')->unique()->values()->all());
        $out = [];
        foreach ($articles as $a) {
            $t = $snapshots[$a->id][$language] ?? $snapshots[$a->id]['en'] ?? null;
            $category = $categories[$a->category_id] ?? null;
            if ($t === null || $category === null) {
                continue;
            }
            $out[] = HelpPresenter::link($a, $t, $category, $language);
        }

        return $out;
    }

    /** @return list<array<string, mixed>> ≤ 8 most viewed in 7 days (ties: newest) */
    public function popular(string $language): array
    {
        $views = HelpViews::lastSevenDays();
        $articles = $this->published()->sortBy(fn (HelpArticle $a) => [-($views[$a->id] ?? 0), -($a->last_published_at?->getTimestamp() ?? 0)])
            ->take(self::POPULAR)->values();

        return $this->links($articles, $language);
    }

    /**
     * P89C-10: staff picks that are published (≤ 5), topped up to 3 with the most viewed of the same category.
     *
     * @return list<array<string, mixed>>
     */
    public function related(HelpArticle $article, string $language): array
    {
        $ids = array_values(array_filter((array) $article->related_article_ids, fn ($id) => is_string($id) && $id !== $article->id));
        $picked = $ids === [] ? collect() : HelpArticle::query()->whereIn('id', $ids)->where('status', HelpArticle::PUBLISHED)->get()
            ->sortBy(fn (HelpArticle $a) => array_search($a->id, $ids, true))->values();
        if ($picked->count() < 3) {
            $exclude = [...$picked->pluck('id')->all(), $article->id];
            $views = HelpViews::lastSevenDays();
            $fill = $this->published($article->category_id)->reject(fn (HelpArticle $a) => in_array($a->id, $exclude, true))
                ->sortBy(fn (HelpArticle $a) => [-($views[$a->id] ?? 0), -($a->last_published_at?->getTimestamp() ?? 0)])
                ->take(3 - $picked->count());
            $picked = $picked->concat($fill)->values();
        }

        return $this->links($picked->take(5), $language);
    }

    public function myVote(string $articleId, string $userId): ?HelpArticleFeedback
    {
        return HelpArticleFeedback::query()->where('article_id', $articleId)->where('user_id', $userId)->first();
    }
}
