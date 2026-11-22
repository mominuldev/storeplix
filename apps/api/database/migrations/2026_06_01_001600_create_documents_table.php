<?php

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** PHASE-5B-CONTRACT §3 001600 (5b-4): generated PDFs (queued; private disk; 24 h). RLS forced. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('documents', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('kind', 24);
            $table->jsonb('order_ids');
            $table->string('language', 2)->default('en');
            $table->string('status', 16)->default('queued');
            $table->smallInteger('pages')->nullable();
            $table->string('file_path', 255)->nullable();
            $table->integer('bytes')->nullable();
            $table->string('error_code', 48)->nullable();
            $table->timestampTz('expires_at')->nullable();
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'created_at']);
            $table->index(['status', 'expires_at']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });

        $db = DB::connection();
        if ($db->getDriverName() === 'pgsql') {
            $db->statement("ALTER TABLE documents ADD CONSTRAINT documents_kind_check CHECK (kind IN ('invoice_a4','receipt_80mm','invoice_a5_two_up','packing_slip','label_4x6'))");
            $db->statement("ALTER TABLE documents ADD CONSTRAINT documents_status_check CHECK (status IN ('queued','rendering','ready','failed','expired'))");
            $db->statement("ALTER TABLE documents ADD CONSTRAINT documents_language_check CHECK (language IN ('en','bn'))");
            RlsPolicies::enable($db, 'documents');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('documents');
    }
};
