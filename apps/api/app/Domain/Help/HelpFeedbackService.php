<?php

declare(strict_types=1);

namespace App\Domain\Help;

use App\Domain\Help\Models\HelpArticle;
use App\Domain\Help\Models\HelpArticleFeedback;
use Illuminate\Support\Str;

/**
 * "Was this helpful?" (PHASE-8-9C P89C-9, S257): one vote per member per guide, changeable and removable. The vote row
 * and the `helpful_yes/no` counters change in one transaction under the article row lock (platform connection: the app
 * role may not update `help_articles`), so counters always equal the rows.
 */
final class HelpFeedbackService
{
    /** @param array{helpful: bool, language: string, reason?: string|null, note?: string|null} $input */
    public function vote(HelpArticle $article, string $userId, ?string $tenantId, array $input): HelpArticleFeedback
    {
        return HelpDb::transaction(function () use ($article, $userId, $tenantId, $input) {
            $locked = HelpDb::query(HelpArticle::class)->whereKey($article->id)->lockForUpdate()->firstOrFail();
            $existing = HelpDb::query(HelpArticleFeedback::class)->where('article_id', $article->id)->where('user_id', $userId)->first();
            $helpful = (bool) $input['helpful'];
            $note = $helpful ? null : self::note($input['note'] ?? null);
            $values = [
                'tenant_id' => $tenantId,
                'language' => $input['language'],
                'helpful' => $helpful,
                'reason' => $helpful ? null : ($input['reason'] ?? null),
                'note' => $note,
            ];
            $yes = $locked->helpful_yes;
            $no = $locked->helpful_no;
            if ($existing instanceof HelpArticleFeedback) {
                $existing->helpful ? $yes-- : $no--;
                $existing->forceFill($values)->save();
                $row = $existing;
            } else {
                /** @var HelpArticleFeedback $row */
                $row = HelpDb::make(HelpArticleFeedback::class);
                $row->id = strtolower((string) Str::ulid());
                $row->forceFill(['article_id' => $article->id, 'user_id' => $userId] + $values)->save();
            }
            $helpful ? $yes++ : $no++;
            HelpDb::query(HelpArticle::class)->whereKey($article->id)->update(['helpful_yes' => max(0, $yes), 'helpful_no' => max(0, $no)]);

            return $row->refresh();
        });
    }

    public function unvote(HelpArticle $article, string $userId): void
    {
        HelpDb::transaction(function () use ($article, $userId) {
            $locked = HelpDb::query(HelpArticle::class)->whereKey($article->id)->lockForUpdate()->firstOrFail();
            $existing = HelpDb::query(HelpArticleFeedback::class)->where('article_id', $article->id)->where('user_id', $userId)->first();
            if (! $existing instanceof HelpArticleFeedback) {
                return;
            }
            HelpDb::query(HelpArticleFeedback::class)->whereKey($existing->id)->delete();
            HelpDb::query(HelpArticle::class)->whereKey($article->id)->update($existing->helpful
                ? ['helpful_yes' => max(0, $locked->helpful_yes - 1)]
                : ['helpful_no' => max(0, $locked->helpful_no - 1)]);
        });
    }

    /** Plain text ≤ 500: control characters (except newlines) removed, trimmed; empty → null. */
    public static function note(mixed $note): ?string
    {
        if (! is_string($note)) {
            return null;
        }
        $note = trim((string) preg_replace('/[\x00-\x09\x0B-\x1F\x7F]/u', '', str_replace("\r\n", "\n", $note)));

        return $note === '' ? null : mb_substr($note, 0, 500);
    }
}
