<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Phase 4 §2: customers (manual / import; Phase 5 adds storefront). */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('customers', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('name', 120);
            $table->string('phone', 13)->nullable();
            $table->string('email', 254)->nullable();
            $table->string('district', 80)->nullable();
            $table->string('area', 120)->nullable();
            $table->string('channel', 16)->nullable();
            $table->string('source', 16)->default('manual');
            $table->jsonb('tags')->default('[]');
            $table->boolean('accepts_marketing')->default(false);
            $table->integer('orders_count')->default(0);
            $table->bigInteger('total_spent_amount')->default(0);
            $table->timestampTz('last_order_at')->nullable();
            $table->integer('revision')->default(1);
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();
            $table->softDeletesTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'created_at']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });

        DB::statement('CREATE UNIQUE INDEX customers_store_phone_unique ON customers (store_id, phone) WHERE phone IS NOT NULL AND deleted_at IS NULL');
        DB::statement('CREATE UNIQUE INDEX customers_store_email_unique ON customers (store_id, email) WHERE email IS NOT NULL AND deleted_at IS NULL');

        if (DB::getDriverName() === 'pgsql') {
            DB::statement('ALTER TABLE customers ADD CONSTRAINT customers_contact_check CHECK (phone IS NOT NULL OR email IS NOT NULL)');
            DB::statement("ALTER TABLE customers ADD CONSTRAINT customers_channel_check CHECK (channel IS NULL OR channel IN ('facebook','instagram','whatsapp','website','phone','walk_in','other'))");
            DB::statement("ALTER TABLE customers ADD CONSTRAINT customers_source_check CHECK (source IN ('manual','import','storefront'))");
            DB::statement('CREATE EXTENSION IF NOT EXISTS pg_trgm');
            DB::statement('CREATE INDEX customers_name_trgm ON customers USING GIN (name gin_trgm_ops)');
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('customers');
    }
};
