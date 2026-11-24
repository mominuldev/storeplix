<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-8-CONTRACT §4: the fake-order guard. Five store-scoped [S] tables, each with the composite store FK
 * (tenant_id, store_id) → stores(tenant_id, id) and forced RLS (RlsTables::TENANT):
 * `fraud_guard_settings` (one row per store, created lazily), `blocked_phones` (one ACTIVE row per phone),
 * `order_risk_checks` (one per order), `fraud_guard_events` (decision log, 13 months) and `checkout_otps` (24 h).
 * Nothing here holds data of another shop: every row is the store's own (P88-1).
 */
return new class extends Migration
{
    public function up(): void
    {
        $pgsql = DB::getDriverName() === 'pgsql';

        Schema::create('fraud_guard_settings', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->boolean('enabled')->default(true);
            $table->boolean('hold_enabled')->default(true);
            $table->smallInteger('hold_below')->default(60);
            $table->boolean('advance_enabled')->default(true);
            $table->smallInteger('advance_below')->default(75);
            $table->integer('advance_expiry_minutes')->default(1440);
            $table->boolean('advance_cancel_if_unpaid')->default(true);
            $table->boolean('otp_enabled')->default(true);
            $table->boolean('block_returners')->default(true);
            $table->smallInteger('block_after_returns')->default(3);
            $table->boolean('duplicates_enabled')->default(true);
            $table->smallInteger('duplicate_window_hours')->default(24);
            $table->boolean('daily_limit_enabled')->default(true);
            $table->smallInteger('daily_limit')->default(3);
            $table->smallInteger('min_parcels')->default(3);
            $table->foreignUlid('updated_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'store_id']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });

        Schema::create('blocked_phones', function (Blueprint $table) use ($pgsql) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('phone', 13);
            $table->char('customer_id', 26)->nullable();
            $table->string('reason', 16);
            $table->string('note', 200)->nullable();
            $table->string('source', 8);
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampTz('unblocked_at')->nullable();
            $table->foreignUlid('unblocked_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'phone']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            if (! $pgsql) {
                $table->foreign('customer_id')->references('id')->on('customers')->nullOnDelete();
            }
        });

        Schema::create('order_risk_checks', function (Blueprint $table) use ($pgsql) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->char('order_id', 26)->unique();
            $table->string('phone', 13);
            $table->string('tier', 8);
            $table->smallInteger('rate')->nullable();
            $table->integer('delivered')->default(0);
            $table->integer('total')->default(0);
            $table->integer('shop_delivered')->default(0);
            $table->integer('shop_total')->default(0);
            $table->jsonb('reasons');
            $table->string('decision', 12);
            $table->boolean('with_actions')->default(false);
            $table->char('duplicate_of', 26)->nullable();
            $table->char('payment_link_id', 26)->nullable();
            $table->timestampTz('released_at')->nullable();
            $table->foreignUlid('released_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'created_at']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'order_id'])->references(['tenant_id', 'store_id', 'id'])->on('orders')->cascadeOnDelete();
            if (! $pgsql) {
                $table->foreign('duplicate_of')->references('id')->on('orders')->nullOnDelete();
                $table->foreign('payment_link_id')->references('id')->on('payment_links')->nullOnDelete();
            }
        });

        Schema::create('fraud_guard_events', function (Blueprint $table) use ($pgsql) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('type', 20);
            $table->char('order_id', 26)->nullable();
            $table->string('phone', 13);
            $table->jsonb('detail');
            $table->timestampTz('created_at');

            $table->unique(['tenant_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'created_at'], 'fraud_guard_events_list_index');
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            if (! $pgsql) {
                $table->foreign('order_id')->references('id')->on('orders')->nullOnDelete();
            }
        });

        Schema::create('checkout_otps', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('phone', 13);
            $table->char('code_hash', 64);
            $table->smallInteger('attempts')->default(0);
            $table->timestampTz('sent_at');
            $table->timestampTz('expires_at');
            $table->timestampTz('verified_at')->nullable();
            $table->string('ip', 45)->nullable();

            $table->unique(['tenant_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'phone', 'sent_at'], 'checkout_otps_phone_index');
            $table->index('sent_at');
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });

        $db = DB::connection();
        // §4: one ACTIVE block per phone (an unblocked row stays as history; P88-10 remembers the merchant's unblock).
        $db->statement('CREATE UNIQUE INDEX blocked_phones_active_unique ON blocked_phones (tenant_id, store_id, phone) WHERE unblocked_at IS NULL');
        // Overview counts by decision and month (§6.4).
        $db->statement('CREATE INDEX order_risk_checks_decision_index ON order_risk_checks (tenant_id, store_id, decision, created_at)');

        if ($pgsql) {
            $db->statement('DROP INDEX IF EXISTS fraud_guard_events_list_index');
            $db->statement('CREATE INDEX fraud_guard_events_list_index ON fraud_guard_events (tenant_id, store_id, created_at DESC, id DESC)');
            $db->statement('DROP INDEX IF EXISTS checkout_otps_phone_index');
            $db->statement('CREATE INDEX checkout_otps_phone_index ON checkout_otps (tenant_id, store_id, phone, sent_at DESC)');
            foreach ([
                'fraud_guard_settings ADD CONSTRAINT fraud_guard_settings_hold_below_check CHECK (hold_below BETWEEN 1 AND 100)',
                'fraud_guard_settings ADD CONSTRAINT fraud_guard_settings_advance_below_check CHECK (advance_below BETWEEN 1 AND 100 AND advance_below >= hold_below)',
                'fraud_guard_settings ADD CONSTRAINT fraud_guard_settings_expiry_check CHECK (advance_expiry_minutes IN (120, 360, 1440, 2880))',
                'fraud_guard_settings ADD CONSTRAINT fraud_guard_settings_returns_check CHECK (block_after_returns BETWEEN 1 AND 20)',
                'fraud_guard_settings ADD CONSTRAINT fraud_guard_settings_window_check CHECK (duplicate_window_hours IN (6, 12, 24, 48, 72))',
                'fraud_guard_settings ADD CONSTRAINT fraud_guard_settings_daily_limit_check CHECK (daily_limit BETWEEN 1 AND 50)',
                'fraud_guard_settings ADD CONSTRAINT fraud_guard_settings_min_parcels_check CHECK (min_parcels BETWEEN 1 AND 20)',
                "blocked_phones ADD CONSTRAINT blocked_phones_reason_check CHECK (reason IN ('manual','repeat_returns'))",
                "blocked_phones ADD CONSTRAINT blocked_phones_source_check CHECK (source IN ('staff','auto'))",
                'blocked_phones ADD CONSTRAINT blocked_phones_customer_fk FOREIGN KEY (tenant_id, store_id, customer_id) REFERENCES customers (tenant_id, store_id, id) ON DELETE SET NULL (customer_id)',
                "order_risk_checks ADD CONSTRAINT order_risk_checks_tier_check CHECK (tier IN ('good','careful','risky','new'))",
                "order_risk_checks ADD CONSTRAINT order_risk_checks_decision_check CHECK (decision IN ('none','hold','advance','skipped'))",
                'order_risk_checks ADD CONSTRAINT order_risk_checks_duplicate_fk FOREIGN KEY (tenant_id, store_id, duplicate_of) REFERENCES orders (tenant_id, store_id, id) ON DELETE SET NULL (duplicate_of)',
                'order_risk_checks ADD CONSTRAINT order_risk_checks_link_fk FOREIGN KEY (tenant_id, store_id, payment_link_id) REFERENCES payment_links (tenant_id, store_id, id) ON DELETE SET NULL (payment_link_id)',
                "fraud_guard_events ADD CONSTRAINT fraud_guard_events_type_check CHECK (type IN ('held','advance_asked','advance_paid','released','duplicate','blocked_checkout','limit_reached','auto_blocked','otp_failed'))",
                'fraud_guard_events ADD CONSTRAINT fraud_guard_events_order_fk FOREIGN KEY (tenant_id, store_id, order_id) REFERENCES orders (tenant_id, store_id, id) ON DELETE SET NULL (order_id)',
                'checkout_otps ADD CONSTRAINT checkout_otps_attempts_check CHECK (attempts BETWEEN 0 AND 5)',
            ] as $statement) {
                $db->statement("ALTER TABLE {$statement}");
            }
            foreach (['fraud_guard_settings', 'blocked_phones', 'order_risk_checks', 'fraud_guard_events', 'checkout_otps'] as $table) {
                RlsPolicies::enable($db, $table);
            }
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('checkout_otps');
        Schema::dropIfExists('fraud_guard_events');
        Schema::dropIfExists('order_risk_checks');
        Schema::dropIfExists('blocked_phones');
        Schema::dropIfExists('fraud_guard_settings');
    }
};
