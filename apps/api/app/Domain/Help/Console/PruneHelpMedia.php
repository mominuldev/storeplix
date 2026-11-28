<?php

declare(strict_types=1);

namespace App\Domain\Help\Console;

use App\Domain\Help\HelpDb;
use App\Domain\Help\HelpDoc;
use App\Domain\Help\HelpMediaService;
use App\Domain\Help\Models\HelpArticleTranslation;
use App\Domain\Help\Models\HelpMedia;
use Illuminate\Console\Command;

/**
 * PHASE-8-9C §7.3 / S261: nightly, removes help images older than 7 days that no draft or published body references
 * (failed uploads included). A referenced image is never removed.
 */
class PruneHelpMedia extends Command
{
    protected $signature = 'help:prune-media';

    protected $description = 'Delete unreferenced help images older than 7 days';

    public function handle(): int
    {
        $referenced = [];
        HelpDb::query(HelpArticleTranslation::class)->select(['id', 'body', 'published_body'])->orderBy('id')
            ->chunk(200, function ($rows) use (&$referenced) {
                foreach ($rows as $t) {
                    foreach ([...HelpDoc::mediaIds($t->body), ...HelpDoc::mediaIds($t->published_body)] as $id) {
                        $referenced[$id] = true;
                    }
                }
            });
        $deleted = 0;
        foreach (HelpDb::query(HelpMedia::class)->where('created_at', '<', now()->subDays(7))->orderBy('id')->cursor() as $m) {
            if (isset($referenced[$m->id])) {
                continue;
            }
            HelpDb::query(HelpMedia::class)->whereKey($m->id)->delete();
            HelpMediaService::deleteObjects($m);
            $deleted++;
        }
        $this->info("deleted={$deleted}");

        return self::SUCCESS;
    }
}
