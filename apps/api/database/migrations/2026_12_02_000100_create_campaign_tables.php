<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-5-CONTRACT §7.1 000100: marketing campaigns. Store-scoped [S] tables with the composite store FK
 * (tenant_id, store_id) → stores(tenant_id, id). Nullable references that must survive the referenced row
 * (coupon, product, customer, recipient) use `ON DELETE SET NULL (column)` on Postgres (composite FK, only the
 * reference column is nulled); sqlite gets a single-column FK. RLS forced on all three (RlsTables::TENANT).
 */
return new class extends Migration
{
    public function up(): void
    {
        $pgsql = DB::getDriverName() === 'pgsql';

        Schema::create('campaigns', function (Blueprint $table) use ($pgsql) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('name', 80);
            $table->string('channel', 8);
            $table->char('language', 2);
            $table->string('status', 12)->default('draft');
            $table->jsonb('audience');
            $table->text('body');
            $table->string('subject', 150)->nullable();
            $table->ulid('coupon_id')->nullable();
            $table->ulid('product_id')->nullable();
            $table->timestampTz('scheduled_at')->nullable();
            $table->timestampTz('started_at')->nullable();
            $table->timestampTz('completed_at')->nullable();
            $table->timestampTz('cancelled_at')->nullable();
            $table->string('failure_reason', 24)->nullable();
            $table->integer('recipients_count')->default(0);
            $table->integer('sent_count')->default(0);
            $table->integer('failed_count')->default(0);
            $table->integer('skipped_count')->default(0);
            $table->integer('unsubscribed_count')->default(0);
            $table->integer('parts_sent')->default(0);
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->integer('revision')->default(1);
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'status', 'scheduled_at']);
            $table->index(['tenant_id', 'store_id', 'created_at']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            if (! $pgsql) {
                $table->foreign('coupon_id')->references('id')->on('coupons')->nullOnDelete();
                $table->foreign('product_id')->references('id')->on('products')->nullOnDelete();
            }
        });

        Schema::create('campaign_recipients', function (Blueprint $table) use ($pgsql) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('campaign_id');
            $table->ulid('customer_id')->nullable();
            $table->string('channel', 8);
            $table->string('address', 254);
            $table->string('status', 10)->default('queued');
            $table->string('skip_reason', 24)->nullable();
            $table->string('error_code', 24)->nullable();
            $table->smallInteger('parts')->default(0);
            $table->char('unsubscribe_code_hash', 64)->unique();
            $table->string('provider_message_id', 128)->nullable();
            $table->timestampTz('sent_at')->nullable();
            $table->timestampTz('unsubscribed_at')->nullable();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->unique(['campaign_id', 'address']);
            $table->unique(['campaign_id', 'customer_id']);
            $table->index(['campaign_id', 'status']);
            $table->index(['tenant_id', 'store_id', 'customer_id', 'sent_at']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'campaign_id'])->references(['tenant_id', 'store_id', 'id'])->on('campaigns')->cascadeOnDelete();
            if (! $pgsql) {
                $table->foreign('customer_id')->references('id')->on('customers')->nullOnDelete();
            }
        });

        Schema::create('campaign_conversions', function (Blueprint $table) use ($pgsql) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('campaign_id');
            $table->ulid('recipient_id')->nullable();
            $table->ulid('order_id')->unique();
            $table->timestampTz('placed_at');
            $table->timestampTz('created_at')->nullable();

            $table->unique(['tenant_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'campaign_id']);
            $table->index(['tenant_id', 'store_id', 'placed_at']);
            $table->index('recipient_id');
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'campaign_id'])->references(['tenant_id', 'store_id', 'id'])->on('campaigns')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'order_id'])->references(['tenant_id', 'store_id', 'id'])->on('orders')->cascadeOnDelete();
            if (! $pgsql) {
                $table->foreign('recipient_id')->references('id')->on('campaign_recipients')->nullOnDelete();
            }
        });

        if ($pgsql) {
            $db = DB::connection();
            // Newest-first lists read these backwards cheaply; keep them DESC as §7.1 lists them.
            $db->statement('DROP INDEX IF EXISTS campaigns_tenant_id_store_id_created_at_index');
            $db->statement('CREATE INDEX campaigns_tenant_id_store_id_created_at_index ON campaigns (tenant_id, store_id, created_at DESC)');
            $db->statement('DROP INDEX IF EXISTS campaign_recipients_tenant_id_store_id_customer_id_sent_at_index');
            $db->statement('CREATE INDEX campaign_recipients_tenant_id_store_id_customer_id_sent_at_index ON campaign_recipients (tenant_id, store_id, customer_id, sent_at DESC)');
            foreach ([
                "campaigns ADD CONSTRAINT campaigns_channel_check CHECK (channel IN ('sms','email'))",
                "campaigns ADD CONSTRAINT campaigns_language_check CHECK (language IN ('bn','en'))",
                "campaigns ADD CONSTRAINT campaigns_status_check CHECK (status IN ('draft','scheduled','sending','sent','cancelled','failed'))",
                "campaigns ADD CONSTRAINT campaigns_failure_reason_check CHECK (failure_reason IS NULL OR failure_reason IN ('limit','plan','store_unavailable','no_recipients'))",
                "campaigns ADD CONSTRAINT campaigns_audience_check CHECK (jsonb_typeof(audience) = 'object')",
                'campaigns ADD CONSTRAINT campaigns_coupon_fk FOREIGN KEY (tenant_id, store_id, coupon_id) REFERENCES coupons (tenant_id, store_id, id) ON DELETE SET NULL (coupon_id)',
                'campaigns ADD CONSTRAINT campaigns_product_fk FOREIGN KEY (tenant_id, store_id, product_id) REFERENCES products (tenant_id, store_id, id) ON DELETE SET NULL (product_id)',
                "campaign_recipients ADD CONSTRAINT campaign_recipients_channel_check CHECK (channel IN ('sms','email'))",
                "campaign_recipients ADD CONSTRAINT campaign_recipients_status_check CHECK (status IN ('queued','sending','sent','failed','skipped','unknown'))",
                "campaign_recipients ADD CONSTRAINT campaign_recipients_skip_reason_check CHECK (skip_reason IS NULL OR skip_reason IN ('opted_out','customer_deleted','address_changed','not_eligible','cancelled','plan','store_unavailable'))",
                "campaign_recipients ADD CONSTRAINT campaign_recipients_error_code_check CHECK (error_code IS NULL OR error_code IN ('provider_error','invalid_address'))",
                'campaign_recipients ADD CONSTRAINT campaign_recipients_parts_check CHECK (parts >= 0)',
                'campaign_recipients ADD CONSTRAINT campaign_recipients_customer_fk FOREIGN KEY (tenant_id, store_id, customer_id) REFERENCES customers (tenant_id, store_id, id) ON DELETE SET NULL (customer_id)',
                'campaign_conversions ADD CONSTRAINT campaign_conversions_recipient_fk FOREIGN KEY (tenant_id, store_id, recipient_id) REFERENCES campaign_recipients (tenant_id, store_id, id) ON DELETE SET NULL (recipient_id)',
            ] as $statement) {
                $db->statement("ALTER TABLE {$statement}");
            }
            foreach (['campaigns', 'campaign_recipients', 'campaign_conversions'] as $table) {
                RlsPolicies::enable($db, $table);
            }
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('campaign_conversions');
        Schema::dropIfExists('campaign_recipients');
        Schema::dropIfExists('campaigns');
    }
};
