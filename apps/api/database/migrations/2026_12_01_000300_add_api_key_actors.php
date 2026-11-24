<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-4 §5.2 (API-KEYS): writes through the external API record the API key as the actor.
 * - `audit_logs.actor_type` and `order_events.actor_type` CHECKs gain 'api_key' (audit_logs.actor_id = key id).
 * - `order_events` and `inventory_movements` gain `actor_api_key_id` (the key id; `actor_user_id` stays null).
 *   Plain columns without FK: keys are never deleted (revoke keeps the row), and the ledger rows outlive anything.
 * Role catalogue: `developers.manage` lives in code (SystemRole), so no role row changes.
 * The CHECKs exist on Postgres only (sqlite has none).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('order_events', fn (Blueprint $t) => $t->char('actor_api_key_id', 26)->nullable());
        Schema::table('inventory_movements', fn (Blueprint $t) => $t->char('actor_api_key_id', 26)->nullable());

        if (DB::getDriverName() === 'pgsql') {
            DB::statement('ALTER TABLE order_events DROP CONSTRAINT IF EXISTS order_events_actor_check');
            DB::statement("ALTER TABLE order_events ADD CONSTRAINT order_events_actor_check CHECK (actor_type IN ('user','customer','system','api_key'))");
            DB::statement('ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_actor_type_check');
            DB::statement("ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_actor_type_check CHECK (actor_type IS NULL OR actor_type IN ('user','system','platform_user','api_key'))");
        }
    }

    public function down(): void
    {
        // Forward-only once merged (CLAUDE.md); down() exists for local rollbacks only.
        if (DB::getDriverName() === 'pgsql') {
            DB::table('order_events')->where('actor_type', 'api_key')->update(['actor_type' => 'system']);
            DB::table('audit_logs')->where('actor_type', 'api_key')->update(['actor_type' => 'system']);
            DB::statement('ALTER TABLE order_events DROP CONSTRAINT IF EXISTS order_events_actor_check');
            DB::statement("ALTER TABLE order_events ADD CONSTRAINT order_events_actor_check CHECK (actor_type IN ('user','customer','system'))");
            DB::statement('ALTER TABLE audit_logs DROP CONSTRAINT IF EXISTS audit_logs_actor_type_check');
            DB::statement("ALTER TABLE audit_logs ADD CONSTRAINT audit_logs_actor_type_check CHECK (actor_type IS NULL OR actor_type IN ('user','system','platform_user'))");
        }
        Schema::table('inventory_movements', fn (Blueprint $t) => $t->dropColumn('actor_api_key_id'));
        Schema::table('order_events', fn (Blueprint $t) => $t->dropColumn('actor_api_key_id'));
    }
};
