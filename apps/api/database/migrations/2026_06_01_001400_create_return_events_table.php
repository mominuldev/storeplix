<?php

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** PHASE-5B-CONTRACT §3 001400 (5b-5): append-only return timeline, like order_events. RLS forced. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('return_events', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('return_request_id');
            $table->string('type', 24);
            $table->string('from_status', 16)->nullable();
            $table->string('to_status', 16)->nullable();
            $table->string('actor_type', 16);
            $table->foreignUlid('actor_user_id')->nullable()->constrained('users')->nullOnDelete();
            $table->string('body', 1000)->nullable();
            $table->jsonb('meta')->default('{}');
            $table->timestampTz('created_at')->useCurrent();

            $table->index(['tenant_id', 'store_id', 'return_request_id', 'created_at']);
            $table->foreign(['tenant_id', 'store_id', 'return_request_id'])->references(['tenant_id', 'store_id', 'id'])->on('return_requests')->cascadeOnDelete();
        });

        $db = DB::connection();
        if ($db->getDriverName() === 'pgsql') {
            $db->statement("ALTER TABLE return_events ADD CONSTRAINT return_events_type_check CHECK (type IN ('created','status_changed','note','refund','restock'))");
            $db->statement("ALTER TABLE return_events ADD CONSTRAINT return_events_actor_check CHECK (actor_type IN ('user','customer','system'))");
            RlsPolicies::enable($db, 'return_events');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('return_events');
    }
};
