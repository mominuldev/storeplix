<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-5B-CONTRACT §3 000800 (5b-3): courier columns on `shipments`. 5a manual shipments keep working: every new
 * column is nullable or defaulted, `shipped` stays a valid status, and the one-live-shipment rule now also ignores
 * `booking_failed`.
 */
return new class extends Migration
{
    private const STATUSES = "'booking','booked','picked_up','in_transit','out_for_delivery','on_hold','delivery_failed',"
        ."'delivered','partially_delivered','returning','returned','cancelled','booking_failed','shipped'";

    public function up(): void
    {
        Schema::table('shipments', function (Blueprint $table) {
            $table->ulid('courier_account_id')->nullable();
            $table->string('consignment_id', 64)->nullable();
            $table->string('provider_status', 48)->nullable();
            $table->smallInteger('attempts')->default(0);
            $table->integer('weight_grams')->nullable();
            $table->bigInteger('delivery_fee_amount')->nullable();
            $table->bigInteger('cod_charge_amount')->nullable();
            $table->bigInteger('cod_collected_amount')->nullable();
            $table->boolean('cod_overridden')->default(false);
            $table->timestampTz('last_event_at')->nullable();
            $table->timestampTz('last_synced_at')->nullable();
            $table->timestampTz('booked_at')->nullable();
            $table->timestampTz('picked_up_at')->nullable();
            $table->timestampTz('cancelled_at')->nullable();
            $table->timestampTz('settled_at')->nullable();
            $table->string('last_location', 120)->nullable();
            $table->string('failure_reason', 255)->nullable();
            $table->string('problem', 24)->nullable();
            $table->string('idempotency_key', 64)->nullable();
            $table->jsonb('raw')->nullable();
            $table->char('batch_id', 26)->nullable(); // soft ref to shipment_batches (composite FKs can't SET NULL)

            $table->foreign(['tenant_id', 'store_id', 'courier_account_id'])->references(['tenant_id', 'store_id', 'id'])->on('courier_accounts');
            $table->index(['tenant_id', 'store_id', 'status', 'booked_at']);
            $table->index(['tenant_id', 'provider', 'last_synced_at']);
        });

        DB::statement('DROP INDEX IF EXISTS shipments_one_live_per_order');
        DB::statement("CREATE UNIQUE INDEX shipments_one_active_per_order ON shipments (order_id) WHERE status NOT IN ('cancelled','booking_failed')");
        DB::statement('CREATE UNIQUE INDEX shipments_store_provider_consignment_unique ON shipments (store_id, provider, consignment_id) WHERE consignment_id IS NOT NULL');
        DB::statement('CREATE UNIQUE INDEX shipments_store_idempotency_unique ON shipments (store_id, idempotency_key) WHERE idempotency_key IS NOT NULL');

        if (DB::getDriverName() === 'pgsql') {
            DB::statement('ALTER TABLE shipments DROP CONSTRAINT IF EXISTS shipments_status_check');
            DB::statement('ALTER TABLE shipments ADD CONSTRAINT shipments_status_check CHECK (status IN ('.self::STATUSES.'))');
            DB::statement('ALTER TABLE shipments ADD CONSTRAINT shipments_weight_check CHECK (weight_grams BETWEEN 1 AND 100000)');
            DB::statement("ALTER TABLE shipments ADD CONSTRAINT shipments_problem_check CHECK (problem IN ('delivery_failed','on_hold','returning','unknown'))");
            DB::statement('ALTER TABLE shipments ADD CONSTRAINT shipments_courier_amounts_check CHECK ('
                .'(delivery_fee_amount IS NULL OR delivery_fee_amount >= 0) AND (cod_charge_amount IS NULL OR cod_charge_amount >= 0) '
                .'AND (cod_collected_amount IS NULL OR cod_collected_amount >= 0) AND attempts >= 0)');
        }
    }

    public function down(): void
    {
        if (DB::getDriverName() === 'pgsql') {
            foreach (['shipments_weight_check', 'shipments_problem_check', 'shipments_courier_amounts_check', 'shipments_status_check'] as $c) {
                DB::statement("ALTER TABLE shipments DROP CONSTRAINT IF EXISTS {$c}");
            }
        }
        DB::statement('DROP INDEX IF EXISTS shipments_one_active_per_order');
        DB::statement('DROP INDEX IF EXISTS shipments_store_provider_consignment_unique');
        DB::statement('DROP INDEX IF EXISTS shipments_store_idempotency_unique');

        Schema::table('shipments', function (Blueprint $table) {
            $table->dropForeign(['tenant_id', 'store_id', 'courier_account_id']);
            $table->dropIndex(['tenant_id', 'store_id', 'status', 'booked_at']);
            $table->dropIndex(['tenant_id', 'provider', 'last_synced_at']);
            $table->dropColumn([
                'courier_account_id', 'consignment_id', 'provider_status', 'attempts', 'weight_grams', 'delivery_fee_amount',
                'cod_charge_amount', 'cod_collected_amount', 'cod_overridden', 'last_event_at', 'last_synced_at', 'booked_at',
                'picked_up_at', 'cancelled_at', 'settled_at', 'last_location', 'failure_reason', 'problem', 'idempotency_key',
                'raw', 'batch_id',
            ]);
        });

        // Forward-only data: courier rows can't satisfy the 5a CHECK; the rollback is for empty dev databases.
        DB::statement("CREATE UNIQUE INDEX shipments_one_live_per_order ON shipments (order_id) WHERE status <> 'cancelled'");
        if (DB::getDriverName() === 'pgsql') {
            DB::statement("ALTER TABLE shipments ADD CONSTRAINT shipments_status_check CHECK (status IN ('shipped','delivered','returned','cancelled'))");
        }
    }
};
