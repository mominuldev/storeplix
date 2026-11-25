<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-8D §3.1 (part A): one row per till sale, 1:1 with its order (ADR 0025): register, session, location,
 * cashier, cash tendered and change. Money and lines live on the order. Store-scoped [S], forced RLS, every reference
 * through (tenant_id, store_id, id) with RESTRICT (S195).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('pos_sales', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->char('order_id', 26);
            $table->char('session_id', 26);
            $table->char('register_id', 26);
            $table->char('location_id', 26);
            $table->foreignUlid('cashier_id')->constrained('users');
            $table->bigInteger('tendered_cash_amount')->nullable();
            $table->bigInteger('change_amount')->default(0);
            $table->boolean('sms_receipt')->default(false);
            $table->timestampTz('created_at');

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->unique('order_id');
            $table->index(['tenant_id', 'store_id', 'session_id']);
            $table->index(['tenant_id', 'store_id', 'register_id', 'created_at'], 'pos_sales_register_index');
            $table->index(['tenant_id', 'store_id', 'created_at'], 'pos_sales_created_index');
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'order_id'])->references(['tenant_id', 'store_id', 'id'])->on('orders')->restrictOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'session_id'])->references(['tenant_id', 'store_id', 'id'])->on('pos_sessions')->restrictOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'register_id'])->references(['tenant_id', 'store_id', 'id'])->on('pos_registers')->restrictOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'location_id'])->references(['tenant_id', 'store_id', 'id'])->on('locations')->restrictOnDelete();
        });

        if (DB::getDriverName() === 'pgsql') {
            $db = DB::connection();
            $db->statement('DROP INDEX IF EXISTS pos_sales_register_index');
            $db->statement('DROP INDEX IF EXISTS pos_sales_created_index');
            $db->statement('CREATE INDEX pos_sales_register_index ON pos_sales (tenant_id, store_id, register_id, created_at DESC)');
            $db->statement('CREATE INDEX pos_sales_created_index ON pos_sales (tenant_id, store_id, created_at DESC)');
            $db->statement('ALTER TABLE pos_sales ADD CONSTRAINT pos_sales_money_check CHECK (change_amount >= 0 AND (tendered_cash_amount IS NULL OR tendered_cash_amount >= 0))');
            RlsPolicies::enable($db, 'pos_sales');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('pos_sales');
    }
};
