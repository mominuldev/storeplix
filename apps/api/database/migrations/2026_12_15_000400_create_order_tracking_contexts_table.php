<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-9D §3.1 / §5.5: the shopper's first-party click / browser ids and consent at checkout, for the order's
 * server-side purchase and refund events. Written only when the store has a tracking integration. IP / UA nulled after
 * 90 days, row deleted after 180 days (tracking:prune). [S], forced RLS.
 */
return new class extends Migration
{
    public function up(): void
    {
        $pgsql = DB::getDriverName() === 'pgsql';

        Schema::create('order_tracking_contexts', function (Blueprint $table) use ($pgsql) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('order_id')->unique();
            $table->string('consent', 12);
            $table->string('fbp', 200)->nullable();
            $table->string('fbc', 500)->nullable();
            $table->string('ttp', 200)->nullable();
            $table->string('ttclid', 500)->nullable();
            $table->string('ga_client_id', 100)->nullable();
            $table->string('ga_session_id', 100)->nullable();
            $table->string('client_ip', 45)->nullable();
            $table->string('user_agent', 400)->nullable();
            $table->timestampTz('created_at')->nullable();

            $table->index(['tenant_id', 'created_at']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            if (! $pgsql) {
                $table->foreign('order_id')->references('id')->on('orders')->cascadeOnDelete();
            }
        });

        if (! $pgsql) {
            return;
        }
        $db = DB::connection();
        $db->statement('ALTER TABLE order_tracking_contexts ADD CONSTRAINT order_tracking_contexts_order_fk FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id) ON DELETE CASCADE');
        $db->statement("ALTER TABLE order_tracking_contexts ADD CONSTRAINT order_tracking_contexts_consent_check CHECK (consent IN ('granted','denied','not_required'))");
        RlsPolicies::enable($db, 'order_tracking_contexts');
    }

    public function down(): void
    {
        Schema::dropIfExists('order_tracking_contexts');
    }
};
