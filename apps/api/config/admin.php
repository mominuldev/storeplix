<?php

/** PHASE-8-1-CONTRACT §11. */
$list = static fn (string $value): array => array_values(array_filter(array_map('trim', explode(',', $value))));

/*
 * PHASE-8-1 amendment A1-1: environment default for staff two-step sign-in (`platform_settings` overrides it).
 * ADMIN_TWO_FACTOR_REQUIRED=true|false wins; unset (or empty) → false only when APP_ENV=local, true everywhere else.
 * An unreadable value fails safe (required).
 */
$twoFactorEnv = env('ADMIN_TWO_FACTOR_REQUIRED');
$twoFactorDefault = $twoFactorEnv === null || $twoFactorEnv === ''
    ? env('APP_ENV') !== 'local'
    : (filter_var($twoFactorEnv, FILTER_VALIDATE_BOOL, FILTER_NULL_ON_FAILURE) ?? true);

return [
    'app_url' => rtrim((string) env('ADMIN_APP_URL', 'http://localhost:5184'), '/'),
    'email_domains' => $list((string) env('ADMIN_EMAIL_DOMAINS', in_array(env('APP_ENV'), ['local', 'testing'], true) ? '' : 'storeplix.com')),
    'ip_allowlist' => $list((string) env('ADMIN_IP_ALLOWLIST', '')),
    'session_idle_minutes' => (int) env('ADMIN_SESSION_IDLE_MINUTES', 30),
    'session_absolute_hours' => (int) env('ADMIN_SESSION_ABSOLUTE_HOURS', 12),
    'impersonation_minutes' => min(15, (int) env('IMPERSONATION_MINUTES', 15)),
    'impersonation_ticket_seconds' => (int) env('IMPERSONATION_TICKET_SECONDS', 60),
    'two_factor_required_default' => $twoFactorDefault,
];
