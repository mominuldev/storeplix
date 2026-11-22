<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Phase 4 §2: products (price lives on variants; only the enabled-variant price range is denormalised). */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('products', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('name', 200);
            $table->string('slug', 220);
            $table->string('type', 16);
            $table->string('status', 16)->default('draft');
            $table->jsonb('description')->nullable();
            $table->jsonb('options')->default('[]');
            $table->jsonb('tags')->default('[]');
            $table->string('seo_title', 70)->nullable();
            $table->string('seo_description', 160)->nullable();
            $table->char('currency', 3);
            $table->bigInteger('price_min_amount')->default(0);
            $table->bigInteger('price_max_amount')->default(0);
            $table->integer('revision')->default(1);
            $table->timestampTz('published_at')->nullable();
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->foreignUlid('updated_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();
            $table->softDeletesTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'status', 'created_at']);
            $table->index(['tenant_id', 'store_id', 'price_min_amount']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });

        DB::statement('CREATE UNIQUE INDEX products_store_slug_unique ON products (store_id, slug) WHERE deleted_at IS NULL');

        if (DB::getDriverName() === 'pgsql') {
            DB::statement("ALTER TABLE products ADD CONSTRAINT products_type_check CHECK (type IN ('simple','variable'))");
            DB::statement("ALTER TABLE products ADD CONSTRAINT products_status_check CHECK (status IN ('draft','active','archived'))");
            DB::statement('CREATE EXTENSION IF NOT EXISTS pg_trgm');
            DB::statement('CREATE INDEX products_tags_gin ON products USING GIN (tags)');
            DB::statement('CREATE INDEX products_name_trgm ON products USING GIN (name gin_trgm_ops)');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('products');
    }
};
