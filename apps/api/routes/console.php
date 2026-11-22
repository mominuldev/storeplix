<?php

use Illuminate\Support\Facades\Schedule;

// D3: expired Sanctum tokens are pruned daily (24h after expiry).
Schedule::command('sanctum:prune-expired --hours=24')->daily();

// Phase 2: expired trials move to the Free plan.
Schedule::command('subscriptions:end-trials')->daily();

// Phase 4: bulk-data retention.
Schedule::command('data:prune-imports')->daily();
Schedule::command('data:expire-exports')->hourly();
