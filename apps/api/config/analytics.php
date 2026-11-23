<?php

/** PHASE-8-2-CONTRACT §4.4 / §11 (ADR 0016): nightly platform analytics. */
return [
    // Dhaka days (P82-2). Every store is in Bangladesh; not configurable per store.
    'timezone' => (string) env('ANALYTICS_TIMEZONE', 'Asia/Dhaka'),
    // Flows (orders, GMV) are restated for this many days before the newest night, then frozen (P82-3, P82-11).
    'restate_days' => (int) env('ANALYTICS_RESTATE_DAYS', 35),
    // The hourly catch-up fills missing closed days this far back from current state (P82-3, P82-4).
    'catchup_days' => (int) env('ANALYTICS_CATCHUP_DAYS', 7),
    // A first payment this many days after the trial ended still counts as a trial conversion (P82-13).
    'trial_conversion_days' => (int) env('ANALYTICS_TRIAL_CONVERSION_DAYS', 7),
    // Response cache per endpoint + params + as_of + computed_at (P82-19).
    'cache_seconds' => (int) env('ANALYTICS_CACHE_SECONDS', 3600),
];
