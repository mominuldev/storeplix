<?php

declare(strict_types=1);

// Phase 8.8d POS (PHASE-8-8D-CONTRACT §1, P88D-4 / P88D-15). Money in minor units (paisa).
return [
    // |counted − expected| above this needs a close note (422 close_note_required). Default ৳ 50.
    'variance_tolerance_amount' => (int) env('POS_VARIANCE_TOLERANCE_AMOUNT', 5000),

    // Active registers per store (409 register_limit_reached on the 11th).
    'max_registers' => 10,

    // BDT notes and coins on the open / close count tables (minor units); non-BDT stores enter one amount.
    'denominations' => [
        'BDT' => [100000, 50000, 20000, 10000, 5000, 2000, 1000, 500, 200, 100],
    ],

    // Count per denomination (0–10,000) and the largest single cash amount.
    'max_count' => 10000,
    'max_cash_amount' => 100000000,
];
