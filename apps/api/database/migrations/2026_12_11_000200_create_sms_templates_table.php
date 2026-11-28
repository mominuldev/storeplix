<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-9A §3.1, §7 (P89A-7/8): per-store custom SMS bodies (bn/en) for the 6 order events and the POS receipt. Only
 * custom bodies are stored (saving the default text deletes the row). Store-scoped [S] with the composite store FK and
 * forced RLS. One row per (store, key, language).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('sms_templates', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('key', 24);
            $table->char('language', 2);
            $table->text('body');
            $table->integer('revision')->default(1);
            $table->foreignUlid('updated_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['store_id', 'key', 'language']);
            $table->index(['tenant_id', 'store_id']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });

        if (DB::getDriverName() === 'pgsql') {
            $db = DB::connection();
            foreach ([
                "sms_templates ADD CONSTRAINT sms_templates_key_check CHECK (key IN ('order_placed','order_confirmed','order_shipped','order_cancelled','order_updated','payment_link','pos_receipt'))",
                "sms_templates ADD CONSTRAINT sms_templates_language_check CHECK (language IN ('bn','en'))",
                'sms_templates ADD CONSTRAINT sms_templates_body_check CHECK (char_length(body) BETWEEN 1 AND 480)',
                'sms_templates ADD CONSTRAINT sms_templates_revision_check CHECK (revision >= 1)',
            ] as $statement) {
                $db->statement("ALTER TABLE {$statement}");
            }
            RlsPolicies::enable($db, 'sms_templates');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('sms_templates');
    }
};
