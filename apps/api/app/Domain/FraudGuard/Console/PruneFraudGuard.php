<?php

declare(strict_types=1);

namespace App\Domain\FraudGuard\Console;

use App\Domain\FraudGuard\Models\CheckoutOtp;
use App\Domain\FraudGuard\Models\FraudGuardEvent;
use Illuminate\Console\Command;

/** `fraud:prune` (daily, PHASE-8-8 §9): checkout OTPs older than 24 h; decision-log rows older than 13 months. */
class PruneFraudGuard extends Command
{
    protected $signature = 'fraud:prune';

    protected $description = 'Delete old checkout codes and fake-order guard log rows';

    public function handle(): int
    {
        // cross-tenant: retention sweep by age only (no tenant data is read or moved).
        $otps = CheckoutOtp::withoutTenancy()->where('sent_at', '<', now()->subHours((int) config('fraud_guard.otp_retention_hours', 24)))->delete();
        // cross-tenant: retention sweep by age only.
        $events = FraudGuardEvent::withoutTenancy()->where('created_at', '<', now()->subMonths((int) config('fraud_guard.event_retention_months', 13)))->delete();
        $this->info("fraud:prune: {$otps} codes, {$events} events.");

        return self::SUCCESS;
    }
}
