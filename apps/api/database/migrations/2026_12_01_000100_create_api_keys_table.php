<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-4 §5.1 (API-KEYS, P84-1..P84-3): tenant-level API keys. Only the sha256 of the plain key is stored
 * (`key_hash`, unique) plus its display prefix and last four characters; the plain key is shown once. RLS forced
 * (RlsTables::TENANT). Also ships `sp_api_key_owner(p_hash)`: the pre-tenant lookup of the external API middleware
 * (hash → tenant/key ids of a non-revoked key), like `sp_route_key_owner` (5b-2 B12).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('api_keys', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->string('name', 60);
            $table->string('prefix', 12);
            $table->char('last_four', 4);
            $table->char('key_hash', 64)->unique();
            $table->jsonb('scopes');
            $table->boolean('include_costs')->default(false);
            $table->foreignUlid('created_by_user_id')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampTz('last_used_at')->nullable();
            $table->timestampTz('revoked_at')->nullable();
            $table->foreignUlid('revoked_by_user_id')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->index(['tenant_id', 'revoked_at']);
        });

        $db = DB::connection();
        if ($db->getDriverName() !== 'pgsql') {
            return;
        }

        $db->statement("ALTER TABLE api_keys ADD CONSTRAINT api_keys_prefix_check CHECK (prefix LIKE 'sp\\_live\\_%')");
        $db->statement('ALTER TABLE api_keys ADD CONSTRAINT api_keys_name_check CHECK (length(btrim(name)) BETWEEN 1 AND 60)');
        $db->statement("ALTER TABLE api_keys ADD CONSTRAINT api_keys_scopes_check CHECK (jsonb_typeof(scopes) = 'array')");
        RlsPolicies::enable($db, 'api_keys');

        // P84-3: external API path (no tenant yet) → ids only, non-revoked keys only. Owned by the migrating role.
        $db->statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION sp_api_key_owner(p_hash text)
              RETURNS TABLE (tenant_id text, key_id text)
              LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
            AS $$
              SELECT k.tenant_id::text, k.id::text
                FROM api_keys k
               WHERE k.key_hash = p_hash::bpchar AND k.revoked_at IS NULL
               LIMIT 1
            $$
            SQL);
        $db->statement('REVOKE ALL ON FUNCTION sp_api_key_owner(text) FROM PUBLIC');
        if (RlsPolicies::roleExists($db, RlsPolicies::APP_ROLE)) {
            $db->statement('GRANT EXECUTE ON FUNCTION sp_api_key_owner(text) TO '.RlsPolicies::APP_ROLE);
        }
    }

    public function down(): void
    {
        if (DB::getDriverName() === 'pgsql') {
            DB::statement('DROP FUNCTION IF EXISTS sp_api_key_owner(text)');
        }
        Schema::dropIfExists('api_keys');
    }
};
