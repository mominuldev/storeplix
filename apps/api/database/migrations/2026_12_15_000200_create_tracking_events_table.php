<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-9D §3.1 (P89D-12, P89D-15, P89D-18): the tracking outbox and event log. U(store_integration_id, event_id,
 * channel) makes every server send at most once per destination; `payload` (hashed user data, IP, UA) is nulled when a
 * row is final. Order / payment ids are soft refs (the log outlives them until retention). [S], forced RLS.
 */
return new class extends Migration
{
    public function up(): void
    {
        $pgsql = DB::getDriverName() === 'pgsql';

        Schema::create('tracking_events', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('store_integration_id');
            $table->string('provider', 24);
            $table->string('event_name', 16);
            $table->string('provider_event_name', 40)->nullable();
            $table->string('event_id', 64);
            $table->string('channel', 8);
            $table->string('source', 16);
            $table->boolean('test')->default(false);
            $table->char('order_id', 26)->nullable();
            $table->char('payment_id', 26)->nullable();
            $table->string('page_path', 300)->nullable();
            $table->bigInteger('value_amount')->nullable();
            $table->char('currency', 3)->nullable();
            $table->string('status', 10);
            $table->string('skip_reason', 24)->nullable();
            $table->smallInteger('attempts')->default(0);
            $table->timestampTz('next_attempt_at')->nullable();
            $table->timestampTz('last_attempt_at')->nullable();
            $table->smallInteger('http_status')->nullable();
            $table->string('error_code', 24)->nullable();
            $table->jsonb('payload')->nullable();
            $table->timestampTz('delivered_at')->nullable();
            $table->timestampsTz();

            $table->unique(['store_integration_id', 'event_id', 'channel'], 'tracking_events_dedupe_unique');
            $table->index(['tenant_id', 'store_id', 'store_integration_id', 'created_at', 'id'], 'tracking_events_log_index');
            $table->index('created_at', 'tracking_events_created_index');
            $table->index(['tenant_id', 'order_id']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_integration_id'])->references(['tenant_id', 'id'])->on('store_integrations')->cascadeOnDelete();
        });

        if (! $pgsql) {
            return;
        }
        $db = DB::connection();
        foreach ([
            "tracking_events ADD CONSTRAINT tracking_events_channel_check CHECK (channel IN ('browser','server'))",
            "tracking_events ADD CONSTRAINT tracking_events_source_check CHECK (source IN ('browser_mirror','order','refund','test'))",
            "tracking_events ADD CONSTRAINT tracking_events_status_check CHECK (status IN ('pending','retrying','delivered','failed','skipped'))",
        ] as $statement) {
            $db->statement("ALTER TABLE {$statement}");
        }
        $db->statement('DROP INDEX IF EXISTS tracking_events_log_index');
        $db->statement('CREATE INDEX tracking_events_log_index ON tracking_events (tenant_id, store_id, store_integration_id, created_at DESC, id DESC)');
        $db->statement("CREATE INDEX tracking_events_due_index ON tracking_events (next_attempt_at) WHERE status IN ('pending','retrying')");
        RlsPolicies::enable($db, 'tracking_events');
    }

    public function down(): void
    {
        Schema::dropIfExists('tracking_events');
    }
};
