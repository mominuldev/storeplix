<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-5B-CONTRACT §3 000200 (5b-2): merchant-owned gateway accounts (P5B-10), one per store and provider.
 * `credentials` is encrypted with the dedicated IntegrationCredentials encrypter (never APP_KEY). RLS forced
 * (RlsTables::TENANT). Also ships sp_route_key_owner() (§2.4 B12): webhook route key → owning tenant/store/account;
 * 5b-3 replaces it (CREATE OR REPLACE) to cover courier_accounts too.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('payment_gateway_accounts', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('provider', 16);
            $table->string('mode', 8);
            $table->string('status', 16);
            $table->text('credentials');
            $table->string('credentials_hint', 16)->nullable();
            $table->boolean('enabled')->default(false);
            $table->boolean('is_default')->default(false);
            $table->char('route_key', 32)->unique();
            $table->timestampTz('verified_at')->nullable();
            $table->timestampTz('last_checked_at')->nullable();
            $table->string('last_error_code', 48)->nullable();
            $table->foreignUlid('connected_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampTz('connected_at')->nullable(); // PaymentGatewayAccount.connected_at (types/openapi)
            $table->integer('revision')->default(1);
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->unique(['store_id', 'provider']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });

        DB::statement('CREATE UNIQUE INDEX payment_gateway_accounts_store_default_unique ON payment_gateway_accounts (store_id) WHERE is_default');

        $db = DB::connection();
        if ($db->getDriverName() === 'pgsql') {
            foreach ([
                "payment_gateway_accounts_provider_check CHECK (provider IN ('bkash','sslcommerz'))",
                "payment_gateway_accounts_mode_check CHECK (mode IN ('sandbox','live'))",
                "payment_gateway_accounts_status_check CHECK (status IN ('connected','error','disconnected'))",
                "payment_gateway_accounts_enabled_check CHECK (status = 'connected' OR NOT enabled)",
            ] as $check) {
                $db->statement("ALTER TABLE payment_gateway_accounts ADD CONSTRAINT {$check}");
            }
            RlsPolicies::enable($db, 'payment_gateway_accounts');

            // B12: public webhook path (no tenant header) → ids only. Owned by the migrating role (BYPASSRLS).
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
            $db->statement('REVOKE ALL ON FUNCTION sp_route_key_owner(text, text) FROM PUBLIC');
            if (RlsPolicies::roleExists($db, RlsPolicies::APP_ROLE)) {
                $db->statement('GRANT EXECUTE ON FUNCTION sp_route_key_owner(text, text) TO '.RlsPolicies::APP_ROLE);
            }
        }
    }

    public function down(): void
    {
        if (DB::getDriverName() === 'pgsql') {
            DB::statement('DROP FUNCTION IF EXISTS sp_route_key_owner(text, text)');
        }
        Schema::dropIfExists('payment_gateway_accounts');
    }
};
