<?php

declare(strict_types=1);

namespace App\Domain\Help;

use App\Domain\Help\Models\HelpArticle;
use App\Domain\Help\Models\HelpArticleFeedback;
use App\Domain\Help\Models\HelpArticleTranslation;
use App\Domain\Help\Models\HelpCategory;
use DateTimeInterface;
use Illuminate\Support\Carbon;

/**
 * Merchant help shapes (openapi 1.26.0 `help`; packages/types Help center block). Only published snapshots are ever
 * presented here (S253): never draft fields, never other members' feedback.
 */
final class HelpPresenter
{
    public static function ts(mixed $value): ?string
    {
        if ($value === null || $value === '') {
            return null;
        }

        return ($value instanceof DateTimeInterface ? Carbon::instance($value) : Carbon::parse((string) $value))->utc()->toIso8601ZuluString();
    }

    /** @return array<string, mixed> HelpCategory */
    public static function category(HelpCategory $c, string $language, int $count): array
    {
        return [
            'id' => $c->id,
            'slug' => $c->slug,
            'name' => $c->name($language),
            'description' => $c->description($language),
            'icon' => $c->icon,
            'article_count' => $count,
            'position' => $c->position,
        ];
    }

    /** @return array{id: string, slug: string, name: string} HelpCategoryRef */
    public static function categoryRef(HelpCategory $c, string $language): array
    {
        return ['id' => $c->id, 'slug' => $c->slug, 'name' => $c->name($language)];
    }

    /** @return array<string, mixed> HelpArticleLink */
    public static function link(HelpArticle $a, HelpArticleTranslation $t, HelpCategory $c, string $language): array
    {
        return [
            'id' => $a->id,
            'slug' => $a->slug,
            'title' => (string) $t->published_title,
            'summary' => (string) $t->published_summary,
            'language' => $t->language,
            'category' => self::categoryRef($c, $language),
            'read_minutes' => max(1, (int) $t->read_minutes),
            'updated_at' => self::ts($t->published_at),
        ];
    }

    /** @return array<string, mixed>|null HelpMyVote */
    public static function vote(?HelpArticleFeedback $f): ?array
    {
        return $f === null ? null : [
            'helpful' => (bool) $f->helpful,
            'reason' => $f->reason,
            'note' => $f->note,
            'updated_at' => self::ts($f->updated_at),
        ];
    }

    /**
     * @param  array<string, HelpArticleTranslation>  $snapshots  published translations by language
     * @param  list<array<string, mixed>>  $related
     * @return array<string, mixed> HelpArticle
     */
    public static function article(HelpArticle $a, array $snapshots, HelpCategory $c, string $requested, ?HelpArticleFeedback $vote, array $related): array
    {
        $t = $snapshots[$requested] ?? $snapshots['en'];
        $body = is_array($t->published_body) ? $t->published_body : HelpDoc::empty();

        return [
            'id' => $a->id,
            'slug' => $a->slug,
            'language' => $t->language,
            'requested_language' => $requested,
            'fallback' => $t->language !== $requested,
            'available_languages' => array_values(array_filter(['en', 'bn'], fn ($l) => isset($snapshots[$l]))),
            'title' => (string) $t->published_title,
            'summary' => (string) $t->published_summary,
            'body' => $body,
            'toc' => HelpDoc::toc($body),
            'media' => (object) HelpMediaService::refs(HelpDoc::mediaIds($body), true),
            'category' => self::categoryRef($c, $requested),
            'read_minutes' => max(1, (int) $t->read_minutes),
            'updated_at' => self::ts($t->published_at),
            'helpful' => ['yes_count' => $a->helpful_yes, 'my_vote' => self::vote($vote)],
            'related' => $related,
        ];
    }
}
