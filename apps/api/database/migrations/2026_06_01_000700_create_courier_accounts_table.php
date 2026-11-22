<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-5B-CONTRACT §3 000700 (5b-3): merchant courier accounts (P5B-31/32), one per store and provider.
 * `credentials` and `webhook_secret_encrypted` use the dedicated IntegrationCredentials encrypter; the webhook secret
 * is also kept as a sha256 (`webhook_secret_hash`). RLS forced (RlsTables::TENANT). Replaces sp_route_key_owner()
 * (§2.4 B12) so the public webhook path resolves courier route keys too.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('courier_accounts', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('provider', 16);
            $table->string('mode', 8);
            $table->string('status', 16);
            $table->text('credentials');
            $table->string('credentials_hint', 16)->nullable();
            $table->char('webhook_secret_hash', 64)->nullable();
            $table->text('webhook_secret_encrypted')->nullable();
            $table->char('route_key', 32)->unique();
            $table->jsonb('settings')->default('{}');
            $table->ulid('pickup_location_id')->nullable();
            $table->boolean('is_default')->default(false);
            $table->timestampTz('last_synced_at')->nullable();
            $table->timestampTz('last_webhook_at')->nullable();
            $table->timestampTz('last_checked_at')->nullable();
            $table->string('last_error_code', 48)->nullable();
            $table->foreignUlid('connected_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampTz('connected_at')->nullable(); // CourierAccount.connected_at (types/openapi)
            $table->integer('revision')->default(1);
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->unique(['store_id', 'provider']);
            $table->index(['tenant_id', 'store_id', 'status']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'pickup_location_id'])
                ->references(['tenant_id', 'store_id', 'id'])->on('pickup_locations')->restrictOnDelete();
        });

        DB::statement('CREATE UNIQUE INDEX courier_accounts_store_default_unique ON courier_accounts (store_id) WHERE is_default');

        $db = DB::connection();
        if ($db->getDriverName() === 'pgsql') {
            foreach ([
                "courier_accounts_provider_check CHECK (provider IN ('steadfast','pathao','redx'))",
                "courier_accounts_mode_check CHECK (mode IN ('sandbox','live'))",
                "courier_accounts_status_check CHECK (status IN ('connected','error','disconnected'))",
            ] as $check) {
                $db->statement("ALTER TABLE courier_accounts ADD CONSTRAINT {$check}");
            }
            RlsPolicies::enable($db, 'courier_accounts');

            // B12 (replaces 000200): route key → ids only, gateway and courier accounts. Provider must match.
            $db->statement(<<<'SQL'
                CREATE OR REPLACE FUNCTION sp_route_key_owner(p_provider text, p_key text)
                  RETURNS TABLE (tenant_id text, store_id text, account_id text)
                  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
                AS $$
                  SELECT o.tenant_id, o.store_id, o.account_id FROM (
                    SELECT a.tenant_id::text AS tenant_id, a.store_id::text AS store_id, a.id::text AS account_id
                      FROM payment_gateway_accounts a
                     WHERE a.route_key = p_key::bpchar AND a.provider = p_provider
                    UNION ALL
                    SELECT c.tenant_id::text, c.store_id::text, c.id::text
                      FROM courier_accounts c
                     WHERE c.route_key = p_key::bpchar AND c.provider = p_provider
                  ) o
                  LIMIT 1
                $$
                SQL);
            $db->statement('REVOKE ALL ON FUNCTION sp_route_key_owner(text, text) FROM PUBLIC');
            if (RlsPolicies::roleExists($db, RlsPolicies::APP_ROLE)) {
                $db->statement('GRANT EXECUTE ON FUNCTION sp_route_key_owner(text, text) TO '.RlsPolicies::APP_ROLE);
            }
        }
    }

    public function down(): void
    {
        $db = DB::connection();
        if ($db->getDriverName() === 'pgsql') {
            // Restore the 000200 (gateway-only) version before the table goes.
            $db->statement(<<<'SQL'
                CREATE OR REPLACE FUNCTION sp_route_key_owner(p_provider text, p_key text)
                  RETURNS TABLE (tenant_id text, store_id text, account_id text)
                  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
                AS $$
                  SELECT a.tenant_id::text, a.store_id::text, a.id::text
                    FROM payment_gateway_accounts a
                   WHERE a.route_key = p_key::bpchar AND a.provider = p_provider
                   LIMIT 1
                $$
                SQL);
        }
        Schema::dropIfExists('courier_accounts');
    }
};
