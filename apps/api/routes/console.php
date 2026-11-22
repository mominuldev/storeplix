<?php

use Illuminate\Support\Facades\Schedule;

// D3: expired Sanctum tokens are pruned daily (24h after expiry).
Schedule::command('sanctum:prune-expired --hours=24')->daily();

// Phase 2: expired trials move to the Free plan.
Schedule::command('subscriptions:end-trials')->daily();

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
