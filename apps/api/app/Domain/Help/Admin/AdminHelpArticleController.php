<?php

declare(strict_types=1);

namespace App\Domain\Help\Admin;

use App\Domain\Admin\Tenants\AdminPresenter;
use App\Domain\Admin\Tenants\Http\AdminBillingController;
use App\Domain\Help\HelpArticleService;
use App\Domain\Help\HelpDb;
use App\Domain\Help\Http\Requests\UpdateHelpArticleRequest;
use App\Domain\Help\Models\HelpArticle;
use App\Domain\Help\Models\HelpArticleFeedback;
use App\Domain\Help\Models\HelpArticleTranslation;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Carbon;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

/**
 * `/admin/help-articles…` (PHASE-8-9C §7.1; `platform.can:manage_help_content`). Platform content: no tenant header,
 * every write on the platform connection, audited with the platform actor.
 */
class AdminHelpArticleController
{
    public const TABS = ['all', 'published', 'draft', 'scheduled', 'archived', 'missing_bn'];

    public function __construct(private readonly HelpArticleService $articles) {}

    public function index(Request $request): JsonResponse
    {
        $input = $request->validate([
            'filter' => ['sometimes', 'array'],
            'filter.tab' => ['sometimes', 'nullable', Rule::in(self::TABS)],
            'filter.q' => ['sometimes', 'nullable', 'string', 'min:2', 'max:100'],
            'filter.category' => ['sometimes', 'nullable', 'string', 'size:26'],
            'filter.language' => ['sometimes', 'nullable', Rule::in(['en', 'bn'])],
            'sort' => ['sometimes', 'nullable', Rule::in(['updated', 'title', 'helpful', 'views'])],
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ]);
        $filter = (array) ($input['filter'] ?? []);
        $tab = (string) ($filter['tab'] ?? 'all');
        $missingBn = $this->missingBn();

        $base = function () use ($filter): Builder {
            $q = HelpDb::query(HelpArticle::class);
            if (is_string($term = $filter['q'] ?? null) && trim($term) !== '') {
                $like = '%'.addcslashes(mb_strtolower(trim($term)), '%_\\').'%';
                $q->where(fn (Builder $w) => $w->whereRaw("slug LIKE ? ESCAPE '\\'", [$like])
                    ->orWhereIn('id', HelpDb::connection()->table('help_article_translations')->select('article_id')
                        ->where(fn ($t) => $t->whereRaw("lower(title) LIKE ? ESCAPE '\\'", [$like])->orWhereRaw("lower(keywords) LIKE ? ESCAPE '\\'", [$like]))));
            }
            if (is_string($c = $filter['category'] ?? null) && $c !== '') {
                $q->where('category_id', strtolower($c));
            }
            if (is_string($l = $filter['language'] ?? null) && $l !== '') {
                $q->whereIn('id', HelpDb::connection()->table('help_article_translations')->select('article_id')->where('language', $l)
                    ->where('draft_hash', '<>', HelpArticleService::REMOVED_HASH));
            }

            return $q;
        };
        $applyTab = fn (Builder $q, string $t): Builder => match ($t) {
            'all' => $q->where('status', '<>', HelpArticle::ARCHIVED),
            'missing_bn' => $q->whereIn('id', $missingBn === [] ? ['-'] : $missingBn),
            default => $q->where('status', $t),
        };

        $query = $applyTab($base(), $tab);
        match ((string) ($input['sort'] ?? 'updated')) {
            'title' => $query->orderBy(HelpDb::connection()->table('help_article_translations')->select('title')
                ->whereColumn('help_article_translations.article_id', 'help_articles.id')->where('language', 'en')->limit(1)),
            'helpful' => $query->orderByRaw('CASE WHEN helpful_yes + helpful_no = 0 THEN 1 ELSE 0 END')
                ->orderByRaw('(helpful_yes * 1.0) / (CASE WHEN helpful_yes + helpful_no = 0 THEN 1 ELSE helpful_yes + helpful_no END) DESC'),
            'views' => $query->orderByDesc(HelpDb::connection()->table('help_article_daily_views')->selectRaw('coalesce(sum(views), 0)')
                ->whereColumn('help_article_daily_views.article_id', 'help_articles.id')
                ->where('day', '>=', now()->setTimezone('Asia/Dhaka')->subDays(6)->toDateString())),
            default => $query->orderByDesc('updated_at'),
        };
        $page = $query->orderByDesc('id')->paginate((int) ($input['per_page'] ?? 25));

        $counts = [];
        foreach (self::TABS as $t) {
            $counts[$t] = $applyTab($base(), $t)->count();
        }
        $since = now()->subDays(30);
        $recent = HelpDb::query(HelpArticleFeedback::class)->where('updated_at', '>=', $since)
            ->selectRaw('sum(case when helpful then 1 else 0 end) as yes, count(*) as total')->first();
        $total = (int) ($recent->total ?? 0);

        return AdminPresenter::paginated($page, AdminHelpPresenter::summaries($page->getCollection()->all()), [
            'counts' => $counts,
            'stats' => [
                'published' => HelpDb::query(HelpArticle::class)->where('status', HelpArticle::PUBLISHED)->count(),
                'drafts' => HelpDb::query(HelpArticle::class)->where('status', HelpArticle::DRAFT)->count(),
                'missing_bn' => count($missingBn),
                'helpful_percent_30d' => $total === 0 ? null : (int) round(100 * (int) $recent->yes / $total),
            ],
        ]);
    }

    public function store(Request $request): JsonResponse
    {
        $input = $request->validate([
            'slug' => ['required', 'string', 'max:80', UpdateHelpArticleRequest::SLUG],
            'category_id' => ['required', 'string', 'size:26'],
            'title_en' => ['required', 'string', 'max:120'],
        ]);
        $article = $this->articles->create(AdminBillingController::staff($request), (string) $input['slug'], (string) $input['category_id'], (string) $input['title_en']);

        return AdminPresenter::json(['data' => AdminHelpPresenter::article($article)], 201);
    }

    public function show(string $article): JsonResponse
    {
        return AdminPresenter::json(['data' => AdminHelpPresenter::article($this->articles->find($article))]);
    }

    public function update(UpdateHelpArticleRequest $request, string $article): JsonResponse
    {
        $row = $this->articles->update($article, AdminBillingController::staff($request), $request->validated());

        return AdminPresenter::json(['data' => AdminHelpPresenter::article($row)]);
    }

    public function destroy(Request $request, string $article): Response
    {
        $this->articles->delete($article, AdminBillingController::staff($request));

        return response()->noContent();
    }

    public function publish(Request $request, string $article): JsonResponse
    {
        $input = $request->validate([
            'revision' => ['required', 'integer', 'min:1'],
            'scheduled_at' => ['sometimes', 'nullable', 'date'],
        ]);
        $at = null;
        if (($input['scheduled_at'] ?? null) !== null) {
            $at = Carbon::parse((string) $input['scheduled_at'])->utc();
            if ($at->lt(now()->addMinutes(5)->subSeconds(30)) || $at->gt(now()->addYear())) {
                throw ValidationException::withMessages(['scheduled_at' => ['Pick a time at least 5 minutes and at most a year from now.']]);
            }
        }
        $row = $this->articles->publish($article, AdminBillingController::staff($request), (int) $input['revision'], $at);

        return AdminPresenter::json(['data' => AdminHelpPresenter::article($row)]);
    }

    public function unpublish(Request $request, string $article): JsonResponse
    {
        return AdminPresenter::json(['data' => AdminHelpPresenter::article($this->articles->unpublish($article, AdminBillingController::staff($request)))]);
    }

    public function archive(Request $request, string $article): JsonResponse
    {
        $input = $request->validate(['reason' => ['sometimes', 'nullable', 'string', 'max:500']]);
        $row = $this->articles->archive($article, AdminBillingController::staff($request), $input['reason'] ?? null);

        return AdminPresenter::json(['data' => AdminHelpPresenter::article($row)]);
    }

    public function restore(Request $request, string $article): JsonResponse
    {
        return AdminPresenter::json(['data' => AdminHelpPresenter::article($this->articles->restore($article, AdminBillingController::staff($request)))]);
    }

    /** GET …/feedback → AdminHelpFeedbackEntry[] (newest first, 25 per page). */
    public function feedback(Request $request, string $article): JsonResponse
    {
        $input = $request->validate([
            'filter' => ['sometimes', 'array'],
            'filter.helpful' => ['sometimes', 'nullable', Rule::in(['0', '1', 0, 1, true, false])],
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ]);
        $row = $this->articles->find($article);
        $helpful = $input['filter']['helpful'] ?? null;
        $page = HelpDb::query(HelpArticleFeedback::class)->where('article_id', $row->id)
            ->when($helpful !== null && $helpful !== '', fn ($q) => $q->where('helpful', filter_var($helpful, FILTER_VALIDATE_BOOLEAN)))
            ->orderByDesc('updated_at')->orderByDesc('id')->paginate((int) ($input['per_page'] ?? 25));
        $tenantIds = array_values(array_unique(array_filter($page->getCollection()->pluck('tenant_id')->all())));
        $shops = AdminPresenter::shopRefs($tenantIds);

        return AdminPresenter::paginated($page, array_map(
            fn (HelpArticleFeedback $f) => AdminHelpPresenter::feedbackEntry($f, $f->tenant_id !== null && isset($shops[$f->tenant_id])
                ? ['id' => $f->tenant_id, 'name' => $shops[$f->tenant_id]['name']] : null),
            $page->getCollection()->all(),
        ));
    }

    /**
     * Published or scheduled articles without a complete বাংলা translation ("Missing বাংলা").
     *
     * @return list<string>
     */
    private function missingBn(): array
    {
        $ids = HelpDb::query(HelpArticle::class)->whereIn('status', [HelpArticle::PUBLISHED, HelpArticle::SCHEDULED])->pluck('id')->all();
        if ($ids === []) {
            return [];
        }
        $complete = HelpDb::query(HelpArticleTranslation::class)->whereIn('article_id', $ids)->where('language', 'bn')
            ->where('draft_hash', '<>', HelpArticleService::REMOVED_HASH)->get(HelpArticleTranslation::COLUMNS)
            ->filter(fn (HelpArticleTranslation $t) => HelpArticleService::missing($t) === [])->pluck('article_id')->all();

        return array_values(array_diff($ids, $complete));
    }
}
