<?php

declare(strict_types=1);

namespace App\Domain\Admin\Auth;

/** PHASE-8-1 P8-3: `ADMIN_EMAIL_DOMAINS` (comma-separated; empty = any domain, the local/testing default). */
final class AdminEmailDomains
{
    public static function allows(string $email): bool
    {
        $domains = array_map('strtolower', (array) config('admin.email_domains', []));
        if ($domains === []) {
            return true;
        }
        $at = strrpos($email, '@');

        return $at !== false && in_array(strtolower(substr($email, $at + 1)), $domains, true);
    }
}
