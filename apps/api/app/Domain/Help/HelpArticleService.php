<?php

declare(strict_types=1);

namespace App\Domain\Help;

use App\Domain\Help\Models\HelpArticle;
use App\Domain\Help\Models\HelpArticleRedirect;
use App\Domain\Help\Models\HelpArticleTranslation;
use App\Domain\Help\Models\HelpCategory;
use App\Domain\Help\Models\HelpMedia;
use App\Domain\Identity\Models\User;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Support\Carbon;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Log;
use Illuminate\Validation\ValidationException;

/**
 * Help content writes (PHASE-8-9C §7.1, P89C-3 / P89C-4 / P89C-23): drafts, publish (snapshot copy + search data),
 * schedule, unpublish, archive, restore, delete. All on the platform connection; each write takes the article row
 * FOR UPDATE first, slug changes additionally the `help-slugs` advisory lock (§3.3). Audited with the platform actor
 * (tenant_id null).
 */
final class HelpArticleService
{
    /** A deleted বাংলা draft of a still-published translation: removed at the next publish. */
    public const REMOVED_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

    public function __construct(private readonly AuditLogger $audit) {}

    public function create(User $staff, string $slug, string $categoryId, string $titleEn): HelpArticle
    {
        $id = HelpDb::transaction(function () use ($staff, $slug, $categoryId, $titleEn) {
            $this->slugLock();
            $this->assertCategory($categoryId);
            $this->assertSlugFree($slug, null);

            /** @var HelpArticle $article */
            $article = HelpDb::make(HelpArticle::class);
            $article->forceFill([
                'slug' => $slug,
                'category_id' => strtolower($categoryId),
                'status' => HelpArticle::DRAFT,
                'related_article_ids' => [],
                'created_by' => $staff->id,
                'updated_by' => $staff->id,
                'revision' => 1,
            ])->save();
            $this->writeTranslation($article->id, 'en', ['title' => $titleEn, 'summary' => '', 'body' => HelpDoc::empty(), 'keywords' => []]);

            return $article->id;
        });
        $article = $this->find($id);
        $this->audit->log('help_article.created', $article, ['slug' => $slug], $staff, tenantId: false, platform: true);

        return $article;
    }

    /**
     * PATCH: draft fields only (P89C-4). `translations.bn = null` deletes the বাংলা draft (a published বাংলা translation
     * is removed at the next publish).
     *
     * @param  array<string, mixed>  $input  validated
     */
    public function update(string $id, User $staff, array $input): HelpArticle
    {
        HelpDb::transaction(function () use ($id, $staff, $input) {
            $article = $this->lock($id);
            $this->assertRevision($article, (int) $input['revision']);

            if (array_key_exists('slug', $input) && $input['slug'] !== $article->slug) {
                $this->slugLock();
                $this->assertSlugFree((string) $input['slug'], $article->id);
                if ($article->first_published_at !== null) {
                    /** @var HelpArticleRedirect $redirect */
                    $redirect = HelpDb::make(HelpArticleRedirect::class);
                    $redirect->forceFill(['slug' => $article->slug, 'article_id' => $article->id])->save();
                }
                HelpDb::query(HelpArticleRedirect::class)->where('slug', $input['slug'])->where('article_id', $article->id)->delete();
                $article->slug = (string) $input['slug'];
            }
            if (array_key_exists('category_id', $input)) {
                $this->assertCategory((string) $input['category_id']);
                $article->category_id = strtolower((string) $input['category_id']);
            }
            if (array_key_exists('related_article_ids', $input)) {
                $article->related_article_ids = $this->related((array) $input['related_article_ids'], $article->id);
            }
            $translations = (array) ($input['translations'] ?? []);
            foreach (['en', 'bn'] as $language) {
                if (! array_key_exists($language, $translations)) {
                    continue;
                }
                $value = $translations[$language];
                if ($value === null) {
                    $this->removeTranslation($article->id, $language);

                    continue;
                }
                $this->writeTranslation($article->id, $language, (array) $value);
            }
            $article->forceFill(['updated_by' => $staff->id, 'revision' => $article->revision + 1])->save();
        });

        return $this->find($id);
    }

    /** POST publish: now (null) or schedule a not-yet-live article. */
    public function publish(string $id, User $staff, int $revision, ?Carbon $scheduledAt): HelpArticle
    {
        $action = HelpDb::transaction(function () use ($id, $staff, $revision, $scheduledAt) {
            $article = $this->lock($id);
            $this->assertRevision($article, $revision);
            if ($article->status === HelpArticle::ARCHIVED) {
                throw new ApiException(409, 'invalid_state_transition', 'Restore this guide before publishing it.');
            }
            if ($scheduledAt !== null && $article->status === HelpArticle::PUBLISHED) {
                throw new ApiException(409, 'invalid_state_transition', 'This guide is live: publish changes now instead of scheduling.');
            }
            $translations = $this->translations($article->id);
            $this->assertPublishable($translations);

            if ($scheduledAt !== null) {
                $article->forceFill([
                    'status' => HelpArticle::SCHEDULED, 'scheduled_at' => $scheduledAt, 'updated_by' => $staff->id, 'revision' => $article->revision + 1,
                ])->save();

                return 'help_article.scheduled';
            }
            $this->applyPublish($article, $translations, $staff->id);

            return 'help_article.published';
        });
        $article = $this->find($id);
        $meta = ['slug' => $article->slug];
        if ($action === 'help_article.scheduled') {
            $meta['scheduled_at'] = $article->scheduled_at?->toIso8601ZuluString();
        }
        $this->audit->log($action, $article, $meta, $staff, tenantId: false, platform: true);

        return $article;
    }

    public function unpublish(string $id, User $staff): HelpArticle
    {
        return $this->move($id, $staff, [HelpArticle::PUBLISHED, HelpArticle::SCHEDULED], 'help_article.unpublished', fn (HelpArticle $a) => $a->forceFill([
            'status' => HelpArticle::DRAFT, 'scheduled_at' => null,
        ]), 'Only published or scheduled guides can be unpublished.');
    }

    public function archive(string $id, User $staff, ?string $reason): HelpArticle
    {
        return $this->move($id, $staff, [HelpArticle::DRAFT, HelpArticle::PUBLISHED, HelpArticle::SCHEDULED], 'help_article.archived', fn (HelpArticle $a) => $a->forceFill([
            'status' => HelpArticle::ARCHIVED, 'scheduled_at' => null, 'archived_at' => now(), 'archived_by' => $staff->id,
        ]), 'This guide is already archived.', $reason !== null && trim($reason) !== '' ? ['reason' => mb_substr(trim($reason), 0, 200)] : []);
    }

    public function restore(string $id, User $staff): HelpArticle
    {
        return $this->move($id, $staff, [HelpArticle::ARCHIVED], 'help_article.restored', fn (HelpArticle $a) => $a->forceFill([
            'status' => HelpArticle::DRAFT, 'archived_at' => null, 'archived_by' => null,
        ]), 'Only archived guides can be restored.');
    }

    public function delete(string $id, User $staff): void
    {
        $article = HelpDb::transaction(function () use ($id) {
            $article = $this->lock($id);
            if ($article->first_published_at !== null) {
                throw new ApiException(409, 'invalid_state_transition', 'A guide that was published can only be archived.');
            }
            HelpDb::query(HelpArticle::class)->whereKey($article->id)->delete();

            return $article;
        });
        $this->audit->log('help_article.deleted', $article, ['slug' => $article->slug], $staff, tenantId: false, platform: true);
    }

    /**
     * `help:publish-scheduled` (§7.1): due scheduled articles are published as `system`; one that became incomplete
     * stays scheduled and raises `help_article.schedule_failed` (once per scheduled time) + a warning. Rows locked by a
     * concurrent run are skipped (SKIP LOCKED on Postgres).
     *
     * @return array{published: int, failed: int}
     */
    public function publishDue(): array
    {
        $published = 0;
        $failed = 0;
        $ids = HelpDb::query(HelpArticle::class)->where('status', HelpArticle::SCHEDULED)->where('scheduled_at', '<=', now())
            ->orderBy('scheduled_at')->limit(200)->pluck('id')->all();
        foreach ($ids as $id) {
            $result = HelpDb::transaction(function () use ($id) {
                $query = HelpDb::query(HelpArticle::class)->whereKey($id)->where('status', HelpArticle::SCHEDULED)->where('scheduled_at', '<=', now());
                $article = HelpDb::pgsql() ? $query->lock('for update skip locked')->first() : $query->lockForUpdate()->first();
                if (! $article instanceof HelpArticle) {
                    return null;
                }
                $translations = $this->translations($article->id);
                try {
                    $this->assertPublishable($translations);
                } catch (ApiException $e) {
                    return [$article, $e];
                }
                $this->applyPublish($article, $translations, null);

                return [$article, null];
            });
            if ($result === null) {
                continue;
            }
            [$article, $error] = $result;
            if ($error === null) {
                $published++;
                $this->audit->log('help_article.published', $article, ['slug' => $article->slug, 'scheduled' => true], tenantId: false, system: true);

                continue;
            }
            $failed++;
            $key = 'help:schedule-failed:'.$article->id.':'.$article->scheduled_at?->timestamp;
            if (cache()->add($key, 1, now()->addDays(400))) {
                $this->audit->log('help_article.schedule_failed', $article, ['slug' => $article->slug, 'error' => $error->errorCode, 'details' => $error->details], tenantId: false, system: true);
                Log::warning('help_article.schedule_failed', ['article_id' => $article->id, 'error' => $error->errorCode]);
            }
        }

        return ['published' => $published, 'failed' => $failed];
    }

    // ---------------------------------------------------------------------------------------------------------------

    /**
     * @param  list<string>  $allowed
     * @param  callable(HelpArticle): mixed  $apply
     * @param  array<string, mixed>  $meta
     */
    private function move(string $id, User $staff, array $allowed, string $action, callable $apply, string $refusal, array $meta = []): HelpArticle
    {
        HelpDb::transaction(function () use ($id, $staff, $allowed, $apply, $refusal) {
            $article = $this->lock($id);
            if (! in_array($article->status, $allowed, true)) {
                throw new ApiException(409, 'invalid_state_transition', $refusal);
            }
            $apply($article);
            $article->forceFill(['updated_by' => $staff->id, 'revision' => $article->revision + 1])->save();
        });
        $article = $this->find($id);
        $this->audit->log($action, $article, ['slug' => $article->slug] + $meta, $staff, tenantId: false, platform: true);

        return $article;
    }

    /** @param Collection<string, HelpArticleTranslation> $translations */
    private function applyPublish(HelpArticle $article, Collection $translations, ?string $by): void
    {
        $now = now();
        foreach ($translations as $t) {
            if ($t->draft_hash === self::REMOVED_HASH) {
                HelpDb::query(HelpArticleTranslation::class)->whereKey($t->id)->delete();

                continue;
            }
            if ($t->published_hash === $t->draft_hash && $t->published_at !== null) {
                continue; // unchanged: keeps its "Updated" date
            }
            $text = HelpDoc::text($t->body);
            $words = HelpDoc::wordCount(trim($t->title.' '.$text));
            HelpDb::query(HelpArticleTranslation::class)->whereKey($t->id)->update([
                'published_title' => $t->title,
                'published_summary' => $t->summary,
                'published_body' => json_encode($t->body, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES),
                'published_keywords' => json_encode($t->keywords ?? [], JSON_UNESCAPED_UNICODE),
                'published_hash' => $t->draft_hash,
                'published_at' => $now,
                'body_text' => $text,
                'word_count' => $words,
                'read_minutes' => HelpDoc::readMinutes($words),
                'updated_at' => $now,
            ]);
            HelpSearch::index($t->id);
        }
        $article->forceFill([
            'status' => HelpArticle::PUBLISHED,
            'scheduled_at' => null,
            'first_published_at' => $article->first_published_at ?? $now,
            'last_published_at' => $now,
            'last_published_by' => $by,
            'updated_by' => $by ?? $article->updated_by,
            'revision' => $article->revision + 1,
        ])->save();
    }

    /**
     * P89C-23: English complete (title, summary, body ≥ 1 block); a বাংলা draft that exists must be complete too.
     * Every image of a body that will be published must be `ready` (422 help_article_media_missing).
     *
     * @param  Collection<string, HelpArticleTranslation>  $translations
     */
    private function assertPublishable(Collection $translations): void
    {
        foreach (['en', 'bn'] as $language) {
            $t = $translations->get($language);
            if ($t === null && $language === 'bn') {
                continue;
            }
            if ($t !== null && $t->draft_hash === self::REMOVED_HASH) {
                continue;
            }
            $missing = $t === null ? ['title', 'summary', 'body'] : self::missing($t);
            if ($missing !== []) {
                throw new ApiException(422, 'help_article_incomplete', $language === 'en'
                    ? 'Complete the English title, summary and body before publishing.'
                    : 'Complete or remove the বাংলা translation before publishing.', ['language' => $language, 'fields' => $missing]);
            }
        }
        $ids = [];
        foreach ($translations as $t) {
            if ($t->draft_hash !== self::REMOVED_HASH) {
                array_push($ids, ...HelpDoc::mediaIds($t->body));
            }
        }
        $ids = array_values(array_unique($ids));
        if ($ids !== []) {
            $ready = HelpDb::query(HelpMedia::class)->whereIn('id', $ids)->where('status', HelpMedia::READY)->pluck('id')->all();
            $missingMedia = array_values(array_diff($ids, $ready));
            if ($missingMedia !== []) {
                throw new ApiException(422, 'help_article_media_missing', 'Some images are missing or still processing.', ['media_ids' => $missingMedia]);
            }
        }
    }

    /** @return list<string> */
    public static function missing(HelpArticleTranslation $t): array
    {
        $missing = [];
        if (trim($t->title) === '') {
            $missing[] = 'title';
        }
        if (trim($t->summary) === '') {
            $missing[] = 'summary';
        }
        if (count($t->body['content'] ?? []) < 1) {
            $missing[] = 'body';
        }

        return $missing;
    }

    /** @param array<string, mixed> $value {title, summary, body, keywords} */
    private function writeTranslation(string $articleId, string $language, array $value): void
    {
        $title = trim((string) ($value['title'] ?? ''));
        $summary = trim((string) ($value['summary'] ?? ''));
        $body = HelpDoc::normalise((array) ($value['body'] ?? HelpDoc::empty()));
        $keywords = array_values(array_unique(array_filter(array_map(fn ($k) => trim((string) $k), (array) ($value['keywords'] ?? [])), fn ($k) => $k !== '')));
        $hash = HelpDoc::hash($title, $summary, $body, $keywords);

        $row = HelpDb::query(HelpArticleTranslation::class)->where('article_id', $articleId)->where('language', $language)->first(HelpArticleTranslation::COLUMNS);
        if (! $row instanceof HelpArticleTranslation) {
            /** @var HelpArticleTranslation $row */
            $row = HelpDb::make(HelpArticleTranslation::class);
            $row->forceFill(['article_id' => $articleId, 'language' => $language]);
        }
        $row->forceFill(['title' => $title, 'summary' => $summary, 'body' => $body, 'keywords' => $keywords, 'draft_hash' => $hash])->save();
    }

    private function removeTranslation(string $articleId, string $language): void
    {
        if ($language === 'en') {
            throw ValidationException::withMessages(['translations.en' => ['The English translation is required.']]);
        }
        $row = HelpDb::query(HelpArticleTranslation::class)->where('article_id', $articleId)->where('language', $language)->first(HelpArticleTranslation::COLUMNS);
        if (! $row instanceof HelpArticleTranslation) {
            return;
        }
        if ($row->published_hash === null) {
            HelpDb::query(HelpArticleTranslation::class)->whereKey($row->id)->delete();

            return;
        }
        $row->forceFill(['draft_hash' => self::REMOVED_HASH])->save();
    }

    /**
     * @param  list<mixed>  $ids
     * @return list<string>
     */
    private function related(array $ids, string $self): array
    {
        $ids = array_values(array_unique(array_map(fn ($i) => strtolower((string) $i), $ids)));
        if (in_array($self, $ids, true)) {
            throw ValidationException::withMessages(['related_article_ids' => ['A guide can’t be related to itself.']]);
        }
        if ($ids !== [] && HelpDb::query(HelpArticle::class)->whereIn('id', $ids)->count() !== count($ids)) {
            throw ValidationException::withMessages(['related_article_ids' => ['Some related guides do not exist.']]);
        }

        return $ids;
    }

    /** @return Collection<string, HelpArticleTranslation> keyed by language */
    public function translations(string $articleId): Collection
    {
        return HelpDb::query(HelpArticleTranslation::class)->where('article_id', $articleId)->get(HelpArticleTranslation::COLUMNS)->keyBy('language');
    }

    public function lock(string $id): HelpArticle
    {
        $row = preg_match('/^[0-9A-Za-z]{26}$/', $id) === 1 ? HelpDb::query(HelpArticle::class)->whereKey(strtolower($id))->lockForUpdate()->first() : null;

        return $row instanceof HelpArticle ? $row : throw new ApiException(404, 'not_found', 'Resource not found.');
    }

    public function find(string $id): HelpArticle
    {
        $row = preg_match('/^[0-9A-Za-z]{26}$/', $id) === 1 ? HelpDb::query(HelpArticle::class)->whereKey(strtolower($id))->first() : null;

        return $row instanceof HelpArticle ? $row : throw new ApiException(404, 'not_found', 'Resource not found.');
    }

    private function assertRevision(HelpArticle $article, int $revision): void
    {
        if ($revision !== $article->revision) {
            throw new ApiException(409, 'revision_conflict', 'This guide changed meanwhile. Reload and try again.');
        }
    }

    private function assertCategory(string $id): void
    {
        if (preg_match('/^[0-9A-Za-z]{26}$/', $id) !== 1 || ! HelpDb::query(HelpCategory::class)->whereKey(strtolower($id))->exists()) {
            throw ValidationException::withMessages(['category_id' => ['Choose a topic.']]);
        }
    }

    /** Unique across help_articles.slug ∪ redirects (a redirect of this same article may be reused). */
    private function assertSlugFree(string $slug, ?string $articleId): void
    {
        $taken = HelpDb::query(HelpArticle::class)->where('slug', $slug)->when($articleId !== null, fn ($q) => $q->whereKeyNot($articleId))->exists()
            || HelpDb::query(HelpArticleRedirect::class)->where('slug', $slug)->when($articleId !== null, fn ($q) => $q->where('article_id', '<>', $articleId))->exists();
        if ($taken) {
            throw new ApiException(409, 'help_slug_taken', 'Another guide already uses this link.');
        }
    }

    private function slugLock(): void
    {
        if (HelpDb::pgsql()) {
            HelpDb::connection()->select('SELECT pg_advisory_xact_lock(hashtext(?))', ['help-slugs']);
        }
    }
}
