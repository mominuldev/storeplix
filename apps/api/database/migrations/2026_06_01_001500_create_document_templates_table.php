<?php

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** PHASE-5B-CONTRACT §3 001500 (5b-4): print options per store × kind (JSON config, no merchant HTML). RLS forced. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('document_templates', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('kind', 24);
            $table->jsonb('config');
            $table->integer('revision')->default(1);
            $table->foreignUlid('updated_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['store_id', 'kind']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });

        $db = DB::connection();
        if ($db->getDriverName() === 'pgsql') {
            $db->statement("ALTER TABLE document_templates ADD CONSTRAINT document_templates_kind_check CHECK (kind IN ('invoice_a4','receipt_80mm','invoice_a5_two_up','packing_slip','label_4x6'))");
            RlsPolicies::enable($db, 'document_templates');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('document_templates');
    }
};
