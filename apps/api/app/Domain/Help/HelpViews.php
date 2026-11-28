<?php

declare(strict_types=1);

namespace App\Domain\Help;

use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;

/**
 * Views and "Popular this week" (PHASE-8-9C P89C-11, Q325): a view counts at most once per member per article per Dhaka
 * day (platform cache key `help:view:{user}:{article}:{date}`) into `help_article_daily_views`. No search logging.
 */
final class HelpViews
{
    public const TIMEZONE = 'Asia/Dhaka';

    public static function today(): string
    {
        return now()->setTimezone(self::TIMEZONE)->toDateString();
    }

    public function record(string $userId, string $articleId): void
    {
        $day = self::today();
        if (! Cache::add("help:view:{$userId}:{$articleId}:{$day}", 1, now()->setTimezone(self::TIMEZONE)->endOfDay())) {
            return;
        }
        DB::statement(
            'INSERT INTO help_article_daily_views (article_id, day, views) VALUES (?, ?, 1)
             ON CONFLICT (article_id, day) DO UPDATE SET views = help_article_daily_views.views + 1',
            [$articleId, $day],
        );
    }

    /**
     * Views in the last 7 Dhaka days (today included) per article.
     *
     * @param  list<string>|null  $articleIds  null = all
     * @return array<string, int>
     */
    public static function lastSevenDays(?array $articleIds = null): array
    {
        $from = now()->setTimezone(self::TIMEZONE)->subDays(6)->toDateString();

        return DB::table('help_article_daily_views')->where('day', '>=', $from)
            ->when($articleIds !== null, fn ($q) => $q->whereIn('article_id', $articleIds))
            ->groupBy('article_id')->selectRaw('article_id, sum(views) as v')->pluck('v', 'article_id')
            ->map(fn ($v) => (int) $v)->all();
    }
}
