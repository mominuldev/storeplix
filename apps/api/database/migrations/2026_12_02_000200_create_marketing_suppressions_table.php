<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-5-CONTRACT §7.1 000200: marketing opt-outs (P85-4). One row per (store, channel, normalized address); the
 * source of truth for opt-out, kept forever (P85-28). Store-scoped [S], RLS forced.
 */
return new class extends Migration
{
    public function up(): void
    {
        $pgsql = DB::getDriverName() === 'pgsql';

        Schema::create('marketing_suppressions', function (Blueprint $table) use ($pgsql) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('channel', 8);
            $table->string('address', 254);
            $table->string('source', 12);
            $table->ulid('campaign_id')->nullable();
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampTz('created_at')->nullable();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['store_id', 'channel', 'address']);
            $table->index(['tenant_id', 'store_id', 'created_at']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            if (! $pgsql) {
                $table->foreign('campaign_id')->references('id')->on('campaigns')->nullOnDelete();
            }
        });

        if ($pgsql) {
            $db = DB::connection();
            foreach ([
                "marketing_suppressions ADD CONSTRAINT marketing_suppressions_channel_check CHECK (channel IN ('sms','email'))",
                "marketing_suppressions ADD CONSTRAINT marketing_suppressions_source_check CHECK (source IN ('link','merchant','import'))",
                'marketing_suppressions ADD CONSTRAINT marketing_suppressions_campaign_fk FOREIGN KEY (tenant_id, store_id, campaign_id) REFERENCES campaigns (tenant_id, store_id, id) ON DELETE SET NULL (campaign_id)',
            ] as $statement) {
                $db->statement("ALTER TABLE {$statement}");
            }
            RlsPolicies::enable($db, 'marketing_suppressions');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('marketing_suppressions');
    }
};
