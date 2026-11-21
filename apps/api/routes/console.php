<?php

use Illuminate\Support\Facades\Schedule;

// D3: expired Sanctum tokens are pruned daily (24h after expiry).
Schedule::command('sanctum:prune-expired --hours=24')->daily();
