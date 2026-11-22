<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Phase 4 §2: category tree (depth ≤ 3). */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('categories', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('parent_id')->nullable();
            $table->string('name', 120);
            $table->string('slug', 140);
            $table->string('description', 500)->nullable();
            $table->ulid('image_media_id')->nullable();
            $table->smallInteger('depth');
            $table->integer('position')->default(0);
            $table->boolean('is_visible')->default(true);
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->foreignUlid('updated_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();
            $table->softDeletesTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'parent_id', 'position']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'parent_id'])->references(['tenant_id', 'store_id', 'id'])->on('categories')->restrictOnDelete();
            $table->foreign(['tenant_id', 'image_media_id'])->references(['tenant_id', 'id'])->on('media')->restrictOnDelete();
        });

        DB::statement('CREATE UNIQUE INDEX categories_store_slug_unique ON categories (store_id, slug) WHERE deleted_at IS NULL');

        if (DB::getDriverName() === 'pgsql') {
            DB::statement('ALTER TABLE categories ADD CONSTRAINT categories_depth_check CHECK (depth BETWEEN 1 AND 3)');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('categories');
    }
};
