<?php

namespace App\Domain\Cart\Console;

use App\Domain\Cart\Models\Cart;
use Illuminate\Console\Command;

/** §2 retention: active carts idle 30 days → abandoned; abandoned / converted carts older than 90 days are deleted. */
class PruneCarts extends Command
{
    protected $signature = 'carts:prune';

    protected $description = 'Abandon idle carts and delete old abandoned / converted carts';

    public function handle(): int
    {
        $abandoned = Cart::withoutTenancy()->where('status', Cart::ACTIVE)
            ->where('last_activity_at', '<', now()->subDays(Cart::TTL_DAYS))
            ->update(['status' => Cart::ABANDONED, 'updated_at' => now()]);
        $deleted = Cart::withoutTenancy()->whereIn('status', [Cart::ABANDONED, Cart::CONVERTED])
            ->where('last_activity_at', '<', now()->subDays(90))->delete();
        $this->info("Abandoned {$abandoned} cart(s), deleted {$deleted}.");

        return self::SUCCESS;
    }
}
