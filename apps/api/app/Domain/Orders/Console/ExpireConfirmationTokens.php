<?php

namespace App\Domain\Orders\Console;

use App\Domain\Orders\Models\Order;
use Illuminate\Console\Command;

/** P5-23: the thank-you token is valid 24 h; afterwards its hash is removed. */
class ExpireConfirmationTokens extends Command
{
    protected $signature = 'orders:expire-confirmation-tokens';

    protected $description = 'Remove expired order confirmation tokens';

    public function handle(): int
    {
        $count = Order::withoutTenancy()->whereNotNull('confirmation_token_hash')->where('confirmation_expires_at', '<', now())
            ->update(['confirmation_token_hash' => null]);
        $this->info("Expired {$count} confirmation token(s).");

        return self::SUCCESS;
    }
}
