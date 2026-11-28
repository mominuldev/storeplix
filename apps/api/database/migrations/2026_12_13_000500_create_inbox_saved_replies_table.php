<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-8E §3, §8 (P88E-8): team-shared saved replies, ≤ 200 per store, shortcut unique per store case-insensitively.
 * [S], forced RLS. Adds the attachment → saved reply FK (CASCADE) on Postgres.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('inbox_saved_replies', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('title', 60);
            $table->string('shortcut', 24);
            $table->text('body');
            $table->boolean('show_as_chip')->default(false);
            $table->integer('position')->default(0);
            $table->integer('use_count')->default(0);
            $table->timestampTz('last_used_at')->nullable();
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->foreignUlid('updated_by')->nullable()->constrained('users')->nullOnDelete();
            $table->integer('revision')->default(1);
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'position']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });
        DB::statement('CREATE UNIQUE INDEX inbox_saved_replies_shortcut_unique ON inbox_saved_replies (store_id, lower(shortcut))');

        if (DB::getDriverName() === 'pgsql') {
            $db = DB::connection();
            $db->statement('ALTER TABLE inbox_saved_replies ADD CONSTRAINT inbox_saved_replies_body_check CHECK (char_length(body) BETWEEN 1 AND 1000)');
            $db->statement("ALTER TABLE inbox_saved_replies ADD CONSTRAINT inbox_saved_replies_shortcut_check CHECK (shortcut ~ '^[a-z0-9_-]{2,24}$')");
            $db->statement('ALTER TABLE inbox_attachments ADD CONSTRAINT inbox_attachments_saved_reply_fk FOREIGN KEY (tenant_id, saved_reply_id) REFERENCES inbox_saved_replies (tenant_id, id) ON DELETE CASCADE');
            RlsPolicies::enable($db, 'inbox_saved_replies');
        }
    }

    public function down(): void
    {
        if (DB::getDriverName() === 'pgsql') {
            DB::statement('ALTER TABLE inbox_attachments DROP CONSTRAINT IF EXISTS inbox_attachments_saved_reply_fk');
        }
        Schema::dropIfExists('inbox_saved_replies');
    }
};
