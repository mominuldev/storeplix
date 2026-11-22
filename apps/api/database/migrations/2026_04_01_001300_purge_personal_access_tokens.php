<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * Phase 4.7c (§2): Bearer tokens are gone. Revoke every issued personal access token (merchant-dashboard logins and
 * any leftover test tokens), forcing a fresh cookie login. The table stays for Sanctum; down() is a no-op.
 */
return new class extends Migration
{
    public function up(): void
    {
        DB::table('personal_access_tokens')->delete();
    }

    public function down(): void
    {
        // Revoked tokens are not restored.
    }
};
