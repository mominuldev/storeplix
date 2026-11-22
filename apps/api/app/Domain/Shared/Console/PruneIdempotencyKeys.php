<?php

namespace App\Domain\Shared\Console;

use App\Domain\Shared\Idempotency\IdempotencyKey;
use Illuminate\Console\Command;

/** P5-14: Idempotency-Key rows live 24 h. Platform job: runs across tenants. */
class PruneIdempotencyKeys extends Command
{
    protected $signature = 'idempotency:prune';

    protected $description = 'Delete Idempotency-Key rows past their expiry';

    public function handle(): int
    {
        $deleted = IdempotencyKey::withoutTenancy()->where('expires_at', '<', now())->delete();
        $this->info("Deleted {$deleted} idempotency key(s).");

        return self::SUCCESS;
    }
}
