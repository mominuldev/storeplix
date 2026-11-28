<?php

declare(strict_types=1);

namespace App\Domain\Help\Console;

use App\Domain\Help\HelpArticleService;
use Illuminate\Console\Command;

/** PHASE-8-9C §7.1: every minute, publish scheduled guides whose time has come (actor `system`). */
class PublishScheduledHelpArticles extends Command
{
    protected $signature = 'help:publish-scheduled';

    protected $description = 'Publish scheduled help articles that are due';

    public function handle(HelpArticleService $articles): int
    {
        $result = $articles->publishDue();
        $this->info("published={$result['published']} failed={$result['failed']}");

        return self::SUCCESS;
    }
}
