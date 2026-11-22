<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** PHASE-5B-CONTRACT §3 001100 (5b-3): bulk booking runs (P5B-40), results per order. RLS forced. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('shipment_batches', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('provider', 16);
            $table->string('status', 16)->default('queued');
            $table->smallInteger('total')->default(0);
            $table->smallInteger('booked')->default(0);
            $table->smallInteger('skipped')->default(0);
            $table->smallInteger('failed')->default(0);
            $table->jsonb('results')->default('[]');
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampTz('started_at')->nullable();
            $table->timestampTz('finished_at')->nullable();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'created_at']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });

        $db = DB::connection();
        if ($db->getDriverName() === 'pgsql') {
            foreach ([
                "shipment_batches_status_check CHECK (status IN ('queued','running','completed','failed'))",
                "shipment_batches_provider_check CHECK (provider IN ('steadfast','pathao','redx'))",
                'shipment_batches_counts_check CHECK (total >= 0 AND booked >= 0 AND skipped >= 0 AND failed >= 0)',
            ] as $check) {
                $db->statement("ALTER TABLE shipment_batches ADD CONSTRAINT {$check}");
            }
            RlsPolicies::enable($db, 'shipment_batches');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('shipment_batches');
    }
};
