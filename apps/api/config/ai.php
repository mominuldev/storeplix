<?php

declare(strict_types=1);

/*
 * AI tools (PHASE-8-9D §10–§12, P89D-33–P89D-39, P89D-55). The platform key lives in the secret manager
 * (ANTHROPIC_API_KEY); merchants never bring their own key. `fake` drivers are refused in production (boot check).
 */
return [
    // P89D-36: `anthropic` | `fake` (local, testing, e2e; refused in production by the boot check).
    'driver' => env('AI_DRIVER', 'anthropic'),

    'text' => [
        // Anthropic's current default model (claude-api reference, 2026-11-28); ids are used exactly, never date-suffixed.
        'model' => env('AI_TEXT_MODEL', 'claude-opus-5-5'),
        // output_config.effort (P89D-36).
        'effort' => env('AI_TEXT_EFFORT', 'medium'),
        'max_tokens' => 4096,
        'timeout' => 60, // seconds (enforced by the Guzzle transporter)
        'max_retries' => 2,
        // P89D-37: server-side refusal fallback.
        'fallback_beta' => 'server-side-fallback-2026-07-01',
        'api_key' => env('ANTHROPIC_API_KEY'),
        // Fixed host (P89D-17): the SDK talks to api.anthropic.com only.
        'base_url' => 'https://api.anthropic.com',
        // P89D-38: the main product image, re-encoded JPEG, longest side ≤ 1,568 px.
        'image_max_side' => 1568,
    ],

    // P89D-39 (Q358 open): `fake` until a provider is chosen. In production the AI photos card is "Coming soon".
    'image_driver' => env('AI_IMAGE_DRIVER', 'fake'),

    // P89D-55: credits per request.
    'costs' => ['product_description' => 1, 'photo_edit' => 2],

    // P89D-58 / P89D-18: retention in days.
    'retention' => [
        'originals' => 30,
        'unapplied_results' => 7,
        'outputs' => 90,
    ],

    // P89D-59: per member.
    'limits' => ['per_minute' => 20, 'per_day' => 300],

    // Signed link lifetime for private AI photo results (minutes).
    'result_link_minutes' => 30,
];
