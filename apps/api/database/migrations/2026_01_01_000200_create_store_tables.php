<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('stores', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->string('name');
            $table->string('slug', 63)->unique();
            $table->string('status', 16)->default('draft'); // draft | active | suspended
            $table->char('country', 2);
            $table->char('currency', 3);
            $table->string('business_category', 100)->nullable();
            $table->timestamps();

            $table->index('tenant_id');
            // Composite key so child tables can enforce (tenant_id, store_id) consistency.
            $table->unique(['tenant_id', 'id']);
        });

        Schema::create('store_domains', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('hostname')->unique(); // always stored normalized lowercase
            $table->string('type', 16); // platform | custom
            $table->string('status', 32)->default('pending_verification'); // DomainStatus
            $table->boolean('is_primary')->default(false);
            $table->string('verification_token', 64)->nullable();
            $table->timestamp('verified_at')->nullable();
            $table->timestamps();

            $table->index(['tenant_id', 'store_id']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });

        Schema::create('store_settings', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id')->unique();
            $table->json('theme');
            $table->string('logo_url', 2048)->nullable();
            $table->string('favicon_url', 2048)->nullable();
            $table->string('seo_title')->nullable();
            $table->text('seo_description')->nullable();
            $table->timestamps();

            $table->index('tenant_id');
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('store_settings');
        Schema::dropIfExists('store_domains');
        Schema::dropIfExists('stores');
    }
};
