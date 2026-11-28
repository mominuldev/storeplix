<?php

declare(strict_types=1);

namespace App\Domain\Help\Http\Controllers;

use App\Domain\Help\HelpDoc;
use App\Domain\Help\HelpFeedbackService;
use App\Domain\Help\HelpPresenter;
use App\Domain\Help\HelpReader;
use App\Domain\Help\HelpSearch;
use App\Domain\Help\HelpViews;
use App\Domain\Help\Models\HelpArticle;
use App\Domain\Help\Models\HelpArticleFeedback;
use App\Domain\Help\Models\HelpArticleTranslation;
use App\Domain\Help\Models\HelpCategory;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Validation\Rule;

/**
 * Merchant guides (PHASE-8-9C §4–§6): any member of the tenant (`perm:base`). Only published snapshots (S253).
 * Writes (feedback) are refused for impersonation by the tenant middleware (403 `impersonation_read_only`).
 */
class HelpController
{
    public function __construct(
        private readonly HelpReader $reader,
        private readonly TenantContext $context,
    ) {}

    public function home(Request $request): JsonResponse
    {
        $language = self::language($request);
        $categories = $this->reader->categories($language);

        return self::json(['data' => [
            'categories' => $categories,
            'total_articles' => HelpArticle::query()->where('status', HelpArticle::PUBLISHED)->count(),
            'popular' => $this->reader->popular($language),
            'can_contact_support' => $this->context->allows(Permission::SupportManage),
        ]]);
    }

    public function categories(Request $request): JsonResponse
    {
        return self::json(['data' => $this->reader->categories(self::language($request))]);
    }

    public function category(Request $request, string $slug): JsonResponse
    {
        $language = self::language($request);
        [$category, $count] = $this->reader->category($slug);
        $links = $this->reader->links($this->reader->published($category->id), $language);
        usort($links, fn (array $a, array $b) => strcmp(mb_strtolower($a['title']), mb_strtolower($b['title'])));

        return self::json(['data' => ['category' => HelpPresenter::category($category, $language, $count), 'articles' => $links]]);
    }

    /** §6 search. */
    public function search(Request $request, HelpSearch $search): JsonResponse
    {
        $input = $request->validate([
            'q' => ['required', 'string', 'min:2', 'max:100'],
            'language' => ['sometimes', 'nullable', Rule::in(['both', 'en', 'bn'])],
            'category' => ['sometimes', 'nullable', 'string', 'max:60'],
            'page' => ['sometimes', 'integer', 'min:1', 'max:1000'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:50'],
        ]);
        $language = (string) ($input['language'] ?? 'both');
        $page = (int) ($input['page'] ?? 1);
        $perPage = (int) ($input['per_page'] ?? 20);
        $categoryId = null;
        if (($slug = $input['category'] ?? null) !== null && $slug !== '') {
            $categoryId = HelpCategory::query()->where('slug', $slug)->value('id') ?? '-';
        }
        $result = $search->search((string) $input['q'], $language, $categoryId, $page, $perPage);
        $categories = HelpSearch::categories(array_values(array_unique([
            ...array_map(fn ($r) => (string) $r->category_id, $result['rows']),
            ...array_map(fn ($c) => $c['category_id'], $result['counts']),
        ])));
        $refLanguage = $language === 'bn' ? 'bn' : 'en';

        $rows = [];
        foreach ($result['rows'] as $r) {
            $c = $categories[(string) $r->category_id] ?? null;
            if ($c === null) {
                continue;
            }
            $text = trim(((string) $r->published_summary).' '.((string) $r->body_text));
            $rows[] = [
                'article_id' => (string) $r->article_id,
                'slug' => (string) $r->slug,
                'language' => (string) $r->language,
                'title' => (string) $r->published_title,
                'snippet' => HelpDoc::snippet($text, (string) $input['q']),
                'category' => HelpPresenter::categoryRef($c, (string) $r->language),
                'read_minutes' => max(1, (int) $r->read_minutes),
            ];
        }
        $counts = [];
        foreach ($result['counts'] as $row) {
            if (($c = $categories[$row['category_id']] ?? null) !== null) {
                $counts[] = ['category' => HelpPresenter::categoryRef($c, $refLanguage), 'count' => $row['count'], 'position' => $c->position];
            }
        }
        usort($counts, fn ($a, $b) => $a['position'] <=> $b['position']);

        return self::json(['data' => $rows, 'meta' => [
            'current_page' => $page,
            'per_page' => $perPage,
            'total' => $result['total'],
            'last_page' => max(1, (int) ceil($result['total'] / $perPage)),
            'query' => trim((string) $input['q']),
            'counts_by_category' => array_map(fn ($c) => ['category' => $c['category'], 'count' => $c['count']], $counts),
        ]]);
    }

    /** §5: a published guide (or a redirected slug → canonical). Records a view (P89C-11). */
    public function article(Request $request, string $slug, HelpViews $views): JsonResponse
    {
        $language = self::language($request);
        $article = $this->reader->article($slug);
        $snapshots = [];
        foreach (HelpArticleTranslation::query()->where('article_id', $article->id)->whereNotNull('published_hash')->get(HelpArticleTranslation::COLUMNS) as $t) {
            $snapshots[$t->language] = $t;
        }
        $category = HelpCategory::query()->find($article->category_id);
        if (! isset($snapshots['en']) || ! $category instanceof HelpCategory) {
            throw new ApiException(404, 'help_article_not_found', 'This guide was moved or unpublished.');
        }
        $userId = (string) $request->user()?->getAuthIdentifier();
        $views->record($userId, $article->id);

        return self::json(['data' => HelpPresenter::article(
            $article, $snapshots, $category, $language, $this->reader->myVote($article->id, $userId), $this->reader->related($article, $language),
        )]);
    }

    /** PUT feedback (P89C-9) → HelpMyVote. */
    public function vote(Request $request, string $slug, HelpFeedbackService $feedback): JsonResponse
    {
        $input = $request->validate([
            'helpful' => ['required', 'boolean'],
            'language' => ['required', Rule::in(['en', 'bn'])],
            'reason' => ['sometimes', 'nullable', Rule::in(HelpArticleFeedback::REASONS), Rule::prohibitedIf(fn () => $request->boolean('helpful'))],
            'note' => ['sometimes', 'nullable', 'string', 'max:500', Rule::prohibitedIf(fn () => $request->boolean('helpful') && is_string($request->input('note')) && trim((string) $request->input('note')) !== '')],
        ]);
        $article = $this->reader->article($slug);
        $row = $feedback->vote($article, (string) $request->user()?->getAuthIdentifier(), $this->context->id(), [
            'helpful' => (bool) $input['helpful'],
            'language' => (string) $input['language'],
            'reason' => $input['reason'] ?? null,
            'note' => $input['note'] ?? null,
        ]);

        return self::json(['data' => HelpPresenter::vote($row)]);
    }

    public function unvote(Request $request, string $slug, HelpFeedbackService $feedback): Response
    {
        $feedback->unvote($this->reader->article($slug), (string) $request->user()?->getAuthIdentifier());

        return response()->noContent();
    }

    private static function language(Request $request): string
    {
        $request->validate(['language' => ['sometimes', 'nullable', Rule::in(['en', 'bn'])]]);

        return $request->query('language') === 'bn' ? 'bn' : 'en';
    }

    /** @param array<string, mixed> $body */
    private static function json(array $body): JsonResponse
    {
        return new JsonResponse($body, 200, ['Cache-Control' => 'private, no-store']);
    }
}
