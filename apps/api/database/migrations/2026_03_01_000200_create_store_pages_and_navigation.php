<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

/** Phase 3 §2: pages, navigation menus and store-level SEO. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('store_pages', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('title', 120);
            $table->string('slug', 80);
            $table->string('status', 16)->default('draft'); // draft | published | hidden
            $table->string('template', 32)->default('blank');
            $table->jsonb('body')->default('[]');
            $table->string('seo_title', 70)->nullable();
            $table->string('seo_description', 160)->nullable();
            $table->ulid('og_image_media_id')->nullable();
            $table->unsignedInteger('revision')->default(1);
            $table->timestampTz('published_at')->nullable();
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->foreignUlid('updated_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['store_id', 'slug']);
            $table->index(['tenant_id', 'store_id', 'status']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'og_image_media_id'])->references(['tenant_id', 'id'])->on('media')->restrictOnDelete();
        });

        Schema::create('store_navigation', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('handle', 32); // main | footer | help
            $table->string('title', 40);
            $table->jsonb('items')->default('[]');
            $table->unsignedInteger('revision')->default(1);
            $table->foreignUlid('updated_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamps();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['store_id', 'handle']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });

        Schema::table('store_settings', function (Blueprint $table) {
            $table->ulid('og_image_media_id')->nullable();
            $table->boolean('noindex')->default(false);

            $table->foreign(['tenant_id', 'og_image_media_id'])->references(['tenant_id', 'id'])->on('media')->restrictOnDelete();
        });
    }

    public function down(): void
    {
        Schema::table('store_settings', function (Blueprint $table) {
            $table->dropForeign(['tenant_id', 'og_image_media_id']);
        });
        Schema::table('store_settings', function (Blueprint $table) {
            $table->dropColumn(['og_image_media_id', 'noindex']);
        });

        Schema::dropIfExists('store_navigation');
        Schema::dropIfExists('store_pages');
    }
};
