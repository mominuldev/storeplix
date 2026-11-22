<?php

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-5B-CONTRACT §3 001200 (5b-5): post-delivery returns and exchanges, numbered RT-n per store. RLS forced
 * (RlsTables::TENANT). Adds payments.return_request_id (refunds for a return) when 5b-2's 000300 hasn't yet.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('return_requests', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('order_id');
            $table->string('number', 24);
            $table->bigInteger('sequence');
            $table->string('type', 16);
            $table->string('status', 16);
            $table->string('reason', 24);
            $table->string('source', 16)->default('merchant');
            $table->string('customer_note', 500)->nullable();
            $table->string('pickup_tracking_code', 64)->nullable();
            $table->jsonb('checks')->default('{}');
            $table->bigInteger('requested_amount')->default(0);
            $table->bigInteger('refunded_amount')->default(0);
            $table->char('exchange_order_id', 26)->nullable();
            $table->string('reject_reason', 255)->nullable();
            $table->timestampTz('approved_at')->nullable();
            $table->timestampTz('received_at')->nullable();
            $table->timestampTz('closed_at')->nullable();
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->integer('revision')->default(1);
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->unique(['store_id', 'number']);
            $table->unique(['store_id', 'sequence']);
            $table->index(['tenant_id', 'store_id', 'status', 'created_at']);
            $table->index(['tenant_id', 'store_id', 'order_id']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'order_id'])->references(['tenant_id', 'store_id', 'id'])->on('orders');
            $table->foreign(['tenant_id', 'store_id', 'exchange_order_id'])->references(['tenant_id', 'store_id', 'id'])->on('orders');
        });

        if (! Schema::hasColumn('payments', 'return_request_id')) {
            Schema::table('payments', function (Blueprint $table) {
                $table->char('return_request_id', 26)->nullable();
                $table->index(['tenant_id', 'store_id', 'return_request_id']);
            });
        }

        $db = DB::connection();
        if ($db->getDriverName() === 'pgsql') {
            foreach ([
                "return_requests_type_check CHECK (type IN ('return','exchange'))",
                "return_requests_status_check CHECK (status IN ('requested','approved','received','refunded','exchanged','rejected','closed'))",
                "return_requests_reason_check CHECK (reason IN ('wrong_size','damaged','wrong_item','changed_mind','refused_at_door','other'))",
                "return_requests_source_check CHECK (source IN ('merchant','courier'))",
                'return_requests_money_check CHECK (requested_amount >= 0 AND refunded_amount >= 0)',
            ] as $check) {
                $db->statement("ALTER TABLE return_requests ADD CONSTRAINT {$check}");
            }
            $db->statement('ALTER TABLE payments ADD CONSTRAINT payments_return_request_fk FOREIGN KEY (tenant_id, store_id, return_request_id) REFERENCES return_requests (tenant_id, store_id, id)');
            RlsPolicies::enable($db, 'return_requests');
        }
    }

    public function down(): void
    {
        if (DB::getDriverName() === 'pgsql') {
            DB::statement('ALTER TABLE payments DROP CONSTRAINT IF EXISTS payments_return_request_fk');
        }
        // The column stays when 5b-2's 000300 owns it; it is dropped there.
        if (Schema::hasColumn('payments', 'return_request_id') && ! Schema::hasColumn('payments', 'purpose')) {
            Schema::table('payments', function (Blueprint $table) {
                $table->dropIndex(['tenant_id', 'store_id', 'return_request_id']);
                $table->dropColumn('return_request_id');
            });
        }
        Schema::dropIfExists('return_requests');
    }
};
