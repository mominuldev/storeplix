<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-5B-CONTRACT §3 000900 (5b-3): append-only shipment timeline (no updated_at). Deduplicated on
 * (shipment_id, provider_status, occurred_at) so a webhook and a poll reporting the same courier event write one row.
 * RLS forced.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('shipment_events', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('shipment_id');
            $table->string('status', 24);
            $table->string('provider_status', 48)->nullable();
            $table->string('description', 255)->nullable();
            $table->string('location', 120)->nullable();
            $table->string('source', 8);
            $table->timestampTz('occurred_at');
            $table->timestampTz('created_at')->useCurrent();

            $table->unique(['tenant_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'shipment_id', 'occurred_at']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'shipment_id'])->references(['tenant_id', 'store_id', 'id'])->on('shipments')->cascadeOnDelete();
        });

        DB::statement('CREATE UNIQUE INDEX shipment_events_dedupe_unique ON shipment_events (shipment_id, provider_status, occurred_at) WHERE provider_status IS NOT NULL');

        $db = DB::connection();
        if ($db->getDriverName() === 'pgsql') {
            $db->statement("ALTER TABLE shipment_events ADD CONSTRAINT shipment_events_source_check CHECK (source IN ('webhook','poll','user','system'))");
            RlsPolicies::enable($db, 'shipment_events');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('shipment_events');
    }
};
