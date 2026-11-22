<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-5B-CONTRACT §3 000600 (5b-2, reused by 5b-3): inbound gateway/courier events, deduplicated by
 * U(tenant_id, provider, event_id) (S24). `payload` is scrubbed (PayloadScrubber). Retention 90 days
 * (webhooks:prune). RLS forced.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('webhook_events', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('provider', 16);
            $table->char('account_id', 26);
            $table->string('event_id', 128);
            $table->string('event_type', 64)->nullable();
            $table->jsonb('payload');
            $table->string('status', 16)->default('received');
            $table->smallInteger('attempts')->default(0);
            $table->string('error_code', 48)->nullable();
            $table->timestampTz('received_at');
            $table->timestampTz('processed_at')->nullable();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'provider', 'event_id']);
            $table->index(['tenant_id', 'provider', 'received_at']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });

        $db = DB::connection();
        if ($db->getDriverName() === 'pgsql') {
            $db->statement("ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_status_check CHECK (status IN ('received','processed','ignored','failed'))");
            $db->statement("ALTER TABLE webhook_events ADD CONSTRAINT webhook_events_provider_check CHECK (provider IN ('bkash','sslcommerz','steadfast','pathao','redx'))");
            RlsPolicies::enable($db, 'webhook_events');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('webhook_events');
    }
};
