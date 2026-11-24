<?php

declare(strict_types=1);

namespace App\Domain\Expenses;

use App\Domain\Expenses\Console\PruneExpenseReceipts;
use App\Domain\Expenses\Console\RepeatExpenses;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

/**
 * Phase 8.7 expenses: console commands (schedules in routes/console.php) and the limiters (PHASE-8-7 §8.4, S152) —
 * `expenses-write` 60/min and `expense-receipts` 20/min per user (and tenant). The signed download uses the inline
 * `throttle:60,1,expense-receipts.download` (per IP). Registered from AppServiceProvider.
 */
final class ExpensesServiceProvider extends ServiceProvider
{
    public function boot(): void
    {
        if ($this->app->runningInConsole()) {
            $this->commands([RepeatExpenses::class, PruneExpenseReceipts::class]);
        }

        $by = fn (string $name, Request $r) => $name.':'.($r->user()?->getAuthIdentifier() ?? $r->ip()).'|'.strtolower((string) $r->header('X-Tenant-Id'));
        RateLimiter::for('expenses-write', fn (Request $r) => Limit::perMinute(60)->by($by('expenses-write', $r)));
        RateLimiter::for('expense-receipts', fn (Request $r) => Limit::perMinute(20)->by($by('expense-receipts', $r)));
    }
}
