<?php

declare(strict_types=1);

/*
 * Merchant integration secrets (PHASE-5B-CONTRACT P5B-10, §15). A 32-byte key, base64 ("base64:…" accepted).
 * Generate: php -r "echo 'base64:'.base64_encode(random_bytes(32)), PHP_EOL;"
 * Rotation: move the old key to INTEGRATION_CREDENTIALS_PREVIOUS_KEYS (comma-separated), set the new one, deploy,
 * then run `php artisan integrations:rotate-key`; drop the previous key afterwards.
 */
return [
    'key' => env('INTEGRATION_CREDENTIALS_KEY', ''),
    'previous_keys' => env('INTEGRATION_CREDENTIALS_PREVIOUS_KEYS', ''),
];
