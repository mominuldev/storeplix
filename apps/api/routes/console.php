<?php

use App\Domain\Admin\Impersonation\Console\CloseImpersonations;
use App\Domain\Admin\Suspension\Console\CheckSuspensions;
use Illuminate\Console\Application;
use Illuminate\Support\Facades\Schedule;

// D3: expired Sanctum tokens are pruned daily (24h after expiry).
Schedule::command('sanctum:prune-expired --hours=24')->daily();

// Phase 7 (PHASE-7 §4, §12): billing lifecycle hourly (trial ends, renewals, past_due, expiry, domain detachment) and
// the platform payment reconciler. `subscriptions:end-trials` stays as an ops alias, no longer scheduled.
Schedule::command('billing:run')->hourly()->withoutOverlapping();
Schedule::command('billing:reconcile-payments')->everyFiveMinutes()->withoutOverlapping();

// Phase 4: bulk-data retention.
Schedule::command('data:prune-imports')->daily();
Schedule::command('data:expire-exports')->hourly();

// Phase 5a: carts, idempotency keys and order confirmation tokens.
Schedule::command('carts:prune')->daily();
Schedule::command('idempotency:prune')->hourly();
Schedule::command('orders:expire-confirmation-tokens')->daily();

// Phase 5b-4: generated invoices / labels live 24 h.
Schedule::command('documents:prune')->hourly();

// Phase 5b-2: online payments (PHASE-5B §3; discovery on the platform connection, one tenant job each).
Schedule::command('payments:expire')->everyMinute()->withoutOverlapping();
Schedule::command('payment-links:expire')->everyMinute()->withoutOverlapping();
Schedule::command('payments:reconcile')->everyFiveMinutes()->withoutOverlapping();
Schedule::command('payments:refund-status')->everyTenMinutes()->withoutOverlapping();
Schedule::command('webhooks:prune')->daily();

// Phase 5b-3: couriers (P5B-38 poll every 15 min, P5B-33 unknown booking outcomes every 2 min).
Schedule::command('couriers:sync')->everyFifteenMinutes()->withoutOverlapping();
Schedule::command('couriers:reconcile-bookings')->everyTwoMinutes()->withoutOverlapping();

// Phase 6: custom domains (PHASE-6 §2.2, §11; discovery on the platform connection, one tenant job each).
Schedule::command('domains:check')->everyMinute()->withoutOverlapping();
Schedule::command('domains:reconcile-provider')->dailyAt('03:30')->timezone('Asia/Dhaka')->withoutOverlapping()
    ->when(fn () => ! config('domains.fake'));

// Phase 8.1 (PHASE-8-1 §4.4, owner API-3): impersonation expiry. Registered here (no Admin console provider owned by API-3).
Application::starting(fn (Application $artisan) => $artisan->resolve(CloseImpersonations::class));
Schedule::command('admin:close-impersonations')->everyFiveMinutes()->withoutOverlapping();

// Phase 8.1 (PHASE-8-1 §4.4): repair store/tenant suspension mismatches (owner API-2).
Application::starting(fn (Application $artisan) => $artisan->resolve(CheckSuspensions::class));
Schedule::command('admin:check-suspensions')->hourly()->withoutOverlapping();

// Phase 8.2 (PHASE-8-2 P82-3): nightly analytics; hourly catch-up at :20 Dhaka, in-process (no queue). The first run
// after midnight does the work; a run with nothing missing exits at once.
Schedule::command('analytics:aggregate')->hourlyAt(20)->timezone('Asia/Dhaka')->withoutOverlapping(60)->onOneServer()->runInBackground();

// Phase 8.4 (PHASE-8-4 §4.4, owner API-HOOKS): outbound webhook retry sweep, delivery log retention (30 d, Q135) and
// auto-disable of endpoints failing for 72 h (P84-11). Discovery on the platform connection, work per tenant.
Schedule::command('webhooks:dispatch-due')->everyMinute()->withoutOverlapping();
Schedule::command('webhooks:prune-deliveries')->dailyAt('04:10')->timezone('Asia/Dhaka')->withoutOverlapping();
Schedule::command('webhooks:auto-disable')->hourly()->withoutOverlapping();

// Phase 8.5 (PHASE-8-5 §5.1, P85-16, P85-28): start due campaigns / resume paused ones every minute, mark stuck sends
// `unknown` every 5 minutes, prune recipients after 13 months. Discovery on the platform connection, work per tenant.
Schedule::command('campaigns:dispatch-due')->everyMinute()->withoutOverlapping();
Schedule::command('campaigns:reap-stuck')->everyFiveMinutes()->withoutOverlapping();
Schedule::command('campaigns:prune-recipients')->dailyAt('04:30')->timezone('Asia/Dhaka')->withoutOverlapping();
