<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-8D §3.1 (part B): held (parked) sales per register, ≤ 20 each (P88D-16). They reserve NO stock: lines are
 * only variant ids + quantities, re-priced and re-checked when the sale completes. Store-scoped [S], forced RLS. The
 * register FK cascades (a register's held sales go with it); session and customer are nulled when they go (Postgres
 * column-list SET NULL, so tenant_id / store_id of the composite FK stay).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('pos_held_sales', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->char('register_id', 26);
            $table->char('session_id', 26)->nullable();
            $table->char('customer_id', 26)->nullable();
            $table->string('customer_name', 120)->nullable();
            $table->string('customer_phone', 13)->nullable();
            $table->string('coupon_code', 32)->nullable();
            $table->string('note', 120)->nullable();
            $table->jsonb('lines');
            $table->integer('items_count');
            $table->bigInteger('total_amount');
            $table->char('currency', 3);
            $table->foreignUlid('held_by')->constrained('users');
            $table->timestampTz('created_at');

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'register_id', 'created_at'], 'pos_held_sales_register_index');
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'register_id'])->references(['tenant_id', 'store_id', 'id'])->on('pos_registers')->cascadeOnDelete();
        });

        if (DB::getDriverName() === 'pgsql') {
            $db = DB::connection();
            $db->statement('DROP INDEX IF EXISTS pos_held_sales_register_index');
            $db->statement('CREATE INDEX pos_held_sales_register_index ON pos_held_sales (tenant_id, store_id, register_id, created_at DESC)');
            foreach ([
                'pos_held_sales_session_fk FOREIGN KEY (tenant_id, store_id, session_id) REFERENCES pos_sessions (tenant_id, store_id, id) ON DELETE SET NULL (session_id)',
                'pos_held_sales_customer_fk FOREIGN KEY (tenant_id, store_id, customer_id) REFERENCES customers (tenant_id, store_id, id) ON DELETE SET NULL (customer_id)',
                'pos_held_sales_counts_check CHECK (items_count >= 1 AND total_amount >= 0 AND jsonb_typeof(lines) = \'array\' AND jsonb_array_length(lines) BETWEEN 1 AND 50)',
            ] as $constraint) {
                $db->statement("ALTER TABLE pos_held_sales ADD CONSTRAINT {$constraint}");
            }
            RlsPolicies::enable($db, 'pos_held_sales');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('pos_held_sales');
    }
};
