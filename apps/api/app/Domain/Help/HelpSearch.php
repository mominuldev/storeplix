<?php

declare(strict_types=1);

namespace App\Domain\Help;

use App\Domain\Help\Models\HelpCategory;
use Illuminate\Database\Query\Builder;
use Illuminate\Support\Facades\DB;

/**
 * Guide search (PHASE-8-9C P89C-8, S258) over PUBLISHED snapshots only, one row per matching translation.
 *
 * Postgres: `search_vector @@ websearch_to_tsquery('simple', q)` OR trigram `published_title % q` (rank = ts_rank +
 * 0.5 × similarity), plus a case-insensitive contains-match on the snapshot text so বাংলা words the `simple` parser
 * may not tokenise are still found (rank 0 for those). sqlite (tests/dev): every query term must appear (LIKE, `%` and
 * `_` literal) in the title, keywords, summary or body text; title hits rank first. `q` is always a bound parameter.
 */
final class HelpSearch
{
    /** Rebuilds the search vector of one translation from its published snapshot (Postgres only). */
    public static function index(string $translationId): void
    {
        if (! HelpDb::pgsql()) {
            return;
        }
        HelpDb::connection()->update(<<<'SQL'
            UPDATE help_article_translations SET search_vector =
                setweight(to_tsvector('simple', coalesce(published_title, '')), 'A') ||
                setweight(to_tsvector('simple', coalesce((SELECT string_agg(k, ' ') FROM jsonb_array_elements_text(coalesce(published_keywords, '[]'::jsonb)) AS k), '')), 'B') ||
                setweight(to_tsvector('simple', coalesce(published_summary, '')), 'C') ||
                setweight(to_tsvector('simple', coalesce(body_text, '')), 'D')
            WHERE id = ?
            SQL, [$translationId]);
    }

    /**
     * @return array{rows: list<object>, total: int, counts: list<array{category_id: string, count: int}>}
     */
    public function search(string $q, string $language, ?string $categoryId, int $page, int $perPage): array
    {
        $q = trim($q);
        $base = fn (): Builder => $this->matching($q, $language);

        $counts = $base()->select('a.category_id', DB::raw('count(*) as aggregate'))->groupBy('a.category_id')->get()
            ->map(fn ($r) => ['category_id' => (string) $r->category_id, 'count' => (int) $r->aggregate])->all();
        $filtered = $base()->when($categoryId !== null, fn (Builder $b) => $b->where('a.category_id', $categoryId));
        $total = (clone $filtered)->count();

        $rank = $this->pgsql()
            ? "(CASE WHEN t.search_vector @@ websearch_to_tsquery('simple', ?) THEN ts_rank(t.search_vector, websearch_to_tsquery('simple', ?)) ELSE 0 END + 0.5 * similarity(t.published_title, ?)) as rank"
            : "(CASE WHEN lower(t.published_title) LIKE ? ESCAPE '\\' THEN 2 ELSE 0 END + CASE WHEN lower(coalesce(t.published_summary, '')) LIKE ? ESCAPE '\\' THEN 1 ELSE 0 END) as rank";
        $rankBindings = $this->pgsql() ? [$q, $q, $q] : [self::like($q), self::like($q)];

        $rows = $filtered
            ->select(['t.id', 't.article_id', 't.language', 't.published_title', 't.published_summary', 't.body_text', 't.read_minutes', 'a.slug', 'a.category_id', 'a.last_published_at'])
            ->selectRaw($rank, $rankBindings)
            ->orderByDesc('rank')->orderByDesc('a.last_published_at')->orderBy('t.id')
            ->offset(($page - 1) * $perPage)->limit($perPage)->get()->all();

        return ['rows' => $rows, 'total' => $total, 'counts' => $counts];
    }

    private function matching(string $q, string $language): Builder
    {
        $query = DB::table('help_article_translations as t')->join('help_articles as a', 'a.id', '=', 't.article_id')
            ->where('a.status', 'published')->whereNotNull('t.published_hash')
            ->when($language !== 'both', fn (Builder $b) => $b->where('t.language', $language));

        if ($this->pgsql()) {
            $like = self::like($q);

            return $query->where(fn (Builder $w) => $w
                ->whereRaw("t.search_vector @@ websearch_to_tsquery('simple', ?)", [$q])
                ->orWhereRaw('t.published_title % ?', [$q])
                ->orWhereRaw("lower(t.published_title) LIKE ? ESCAPE '\\'", [$like])
                ->orWhereRaw("lower(coalesce(t.published_summary, '')) LIKE ? ESCAPE '\\'", [$like])
                ->orWhereRaw("lower(coalesce(t.body_text, '')) LIKE ? ESCAPE '\\'", [$like]));
        }

        foreach (self::terms($q) as $term) {
            $like = self::like($term);
            $query->where(fn (Builder $w) => $w
                ->whereRaw("lower(t.published_title) LIKE ? ESCAPE '\\'", [$like])
                ->orWhereRaw("lower(coalesce(t.published_summary, '')) LIKE ? ESCAPE '\\'", [$like])
                ->orWhereRaw("lower(coalesce(t.published_keywords, '')) LIKE ? ESCAPE '\\'", [$like])
                ->orWhereRaw("lower(coalesce(t.body_text, '')) LIKE ? ESCAPE '\\'", [$like]));
        }

        return $query;
    }

    /** @return list<string> */
    public static function terms(string $q): array
    {
        $terms = array_values(array_filter(array_map(fn ($t) => trim($t, "\"'+"), preg_split('/\s+/u', mb_strtolower(trim($q))) ?: []), fn ($t) => $t !== '' && ! str_starts_with($t, '-')));

        return $terms === [] ? [mb_strtolower(trim($q))] : array_slice($terms, 0, 8);
    }

    /** `%term%` with `%`, `_` and `\` literal. */
    public static function like(string $term): string
    {
        return '%'.addcslashes(mb_strtolower(trim($term)), '%_\\').'%';
    }

    private function pgsql(): bool
    {
        return DB::connection()->getDriverName() === 'pgsql';
    }

    /**
     * @param  list<string>  $ids
     * @return array<string, HelpCategory>
     */
    public static function categories(array $ids): array
    {
        return $ids === [] ? [] : HelpCategory::query()->whereIn('id', $ids)->get()->keyBy('id')->all();
    }
}
