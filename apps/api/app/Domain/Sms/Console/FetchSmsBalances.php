<?php

declare(strict_types=1);

namespace App\Domain\Sms\Console;

use App\Domain\Sms\Models\SmsProvider;
use App\Domain\Sms\Providers\SmsBalanceService;
use App\Domain\Tenancy\Support\PlatformDb;
use Illuminate\Console\Command;

/** PHASE-8-9B P89B-23: reads the gateway balance of the primary and the failover (every 15 minutes) + low-balance alerts. */
class FetchSmsBalances extends Command
{
    protected $signature = 'sms:fetch-balances';

    protected $description = 'Read the SMS gateway balances and raise low-balance alerts (PHASE-8-9B §4.7)';

    public function handle(SmsBalanceService $balances): int
    {
        $rows = PlatformDb::reroute(SmsProvider::query())->whereIn('role', [SmsProvider::PRIMARY, SmsProvider::FAILOVER])->get();
        foreach ($rows as $provider) {
            $fresh = $balances->refresh($provider);
            $this->line("{$provider->name}: ".($fresh?->balance_status ?? 'skipped'));
        }

        return self::SUCCESS;
    }
}
