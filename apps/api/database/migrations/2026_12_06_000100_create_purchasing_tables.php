<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-8B-CONTRACT §3: suppliers + purchase orders. Six store-scoped [S] tables, each with the composite store FK
 * (tenant_id, store_id) → stores(tenant_id, id) and forced RLS (RlsTables::TENANT, 82 after Phase 8.8b):
 * `suppliers`, `purchase_orders` (+ `purchase_order_items`), `purchase_receipts` (+ `purchase_receipt_items`) and
 * `supplier_payments`. Every child references its parent through (tenant_id, store_id, id), so a row can never point
 * into another store or tenant (S167). Variants are soft-deleted only, so the variant FK is plain NO ACTION.
 * A receipt's supplier invoice (`invoice_media_id`, purpose `purchase_invoice`) is NO ACTION like the 8.7 receipt.
 * A payment survives the deletion of its draft PO via `ON DELETE SET NULL (purchase_order_id)` on Postgres.
 * `cost_after_amount` is null only for a line that stocked nothing (damaged only) on a variant without a cost.
 */
return new class extends Migration
{
    public function up(): void
    {
        $pgsql = DB::getDriverName() === 'pgsql';

        Schema::create('suppliers', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('name', 120);
            $table->string('contact_name', 120)->nullable();
            $table->string('phone', 13)->nullable();
            $table->string('city', 80)->nullable();
            $table->string('supplies', 200)->nullable();
            $table->smallInteger('payment_terms_days')->nullable();
            $table->smallInteger('advance_percent')->nullable();
            $table->smallInteger('lead_time_days')->nullable();
            $table->string('pays_by_method', 8)->nullable();
            $table->string('pays_by_account', 60)->nullable();
            $table->string('notes', 500)->nullable();
            $table->timestampTz('archived_at')->nullable();
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'phone']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });

        Schema::create('purchase_orders', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->char('supplier_id', 26);
            $table->integer('sequence');
            $table->string('number', 20);
            $table->string('status', 20)->default('draft');
            $table->date('expected_on')->nullable();
            $table->timestampTz('ordered_at')->nullable();
            $table->timestampTz('sent_at')->nullable();
            $table->string('sent_via', 8)->nullable();
            $table->timestampTz('closed_at')->nullable();
            $table->timestampTz('cancelled_at')->nullable();
            $table->string('notes', 1000)->nullable();
            $table->bigInteger('subtotal_amount')->default(0);
            $table->bigInteger('shipping_amount')->default(0);
            $table->bigInteger('discount_amount')->default(0);
            $table->bigInteger('total_amount')->default(0);
            $table->bigInteger('received_value_amount')->default(0);
            $table->bigInteger('paid_amount')->default(0);
            $table->char('currency', 3);
            $table->date('due_on')->nullable();
            $table->integer('revision')->default(1);
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->foreignUlid('updated_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->unique(['store_id', 'number']);
            $table->index(['tenant_id', 'store_id', 'status', 'created_at'], 'purchase_orders_list_index');
            $table->index(['tenant_id', 'store_id', 'supplier_id']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'supplier_id'])->references(['tenant_id', 'store_id', 'id'])->on('suppliers');
        });

        Schema::create('purchase_order_items', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->char('purchase_order_id', 26);
            $table->char('variant_id', 26);
            $table->bigInteger('unit_cost_amount');
            $table->integer('quantity_ordered');
            $table->integer('quantity_received')->default(0);
            $table->integer('quantity_damaged')->default(0);
            $table->smallInteger('position')->default(0);
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->unique(['purchase_order_id', 'variant_id']);
            $table->index(['tenant_id', 'store_id', 'variant_id']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'purchase_order_id'])->references(['tenant_id', 'store_id', 'id'])->on('purchase_orders')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'variant_id'])->references(['tenant_id', 'store_id', 'id'])->on('product_variants');
        });

        Schema::create('purchase_receipts', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->char('purchase_order_id', 26);
            $table->timestampTz('received_at');
            $table->foreignUlid('received_by')->nullable()->constrained('users')->nullOnDelete();
            $table->string('supplier_invoice_ref', 60)->nullable();
            $table->char('invoice_media_id', 26)->nullable()->unique();
            $table->string('note', 500)->nullable();
            $table->bigInteger('value_amount')->default(0);
            $table->timestampTz('created_at');

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'received_at']);
            $table->index('purchase_order_id');
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'purchase_order_id'])->references(['tenant_id', 'store_id', 'id'])->on('purchase_orders')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'invoice_media_id'])->references(['tenant_id', 'id'])->on('media');
        });

        Schema::create('purchase_receipt_items', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->char('purchase_receipt_id', 26);
            $table->char('purchase_order_item_id', 26);
            $table->char('variant_id', 26);
            $table->integer('quantity_received');
            $table->integer('quantity_damaged');
            $table->bigInteger('landed_unit_cost_amount');
            $table->bigInteger('cost_before_amount')->nullable();
            $table->bigInteger('cost_after_amount')->nullable();
            $table->integer('on_hand_before');
            $table->timestampTz('created_at');

            $table->unique(['tenant_id', 'id']);
            $table->index('purchase_receipt_id');
            $table->index('purchase_order_item_id');
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'purchase_receipt_id'])->references(['tenant_id', 'store_id', 'id'])->on('purchase_receipts')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'purchase_order_item_id'])->references(['tenant_id', 'store_id', 'id'])->on('purchase_order_items')->cascadeOnDelete();
        });

        Schema::create('supplier_payments', function (Blueprint $table) use ($pgsql) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->char('supplier_id', 26);
            $table->char('purchase_order_id', 26)->nullable();
            $table->bigInteger('amount');
            $table->char('currency', 3);
            $table->string('method', 8);
            $table->date('paid_on');
            $table->string('reference', 60)->nullable();
            $table->string('note', 200)->nullable();
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'supplier_id', 'paid_on']);
            $table->index(['tenant_id', 'store_id', 'purchase_order_id']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'store_id', 'supplier_id'])->references(['tenant_id', 'store_id', 'id'])->on('suppliers');
            if (! $pgsql) {
                $table->foreign('purchase_order_id')->references('id')->on('purchase_orders')->nullOnDelete();
            }
        });

        $db = DB::connection();
        // §3: one active supplier per name (case-insensitive) in a store; an archived one frees the name.
        $db->statement('CREATE UNIQUE INDEX suppliers_active_name_unique ON suppliers (tenant_id, store_id, lower(name)) WHERE archived_at IS NULL');

        if ($pgsql) {
            $db->statement('DROP INDEX IF EXISTS purchase_orders_list_index');
            $db->statement('CREATE INDEX purchase_orders_list_index ON purchase_orders (tenant_id, store_id, status, created_at DESC)');
            foreach ([
                'suppliers ADD CONSTRAINT suppliers_terms_check CHECK (payment_terms_days IS NULL OR payment_terms_days BETWEEN 0 AND 180)',
                'suppliers ADD CONSTRAINT suppliers_advance_check CHECK (advance_percent IS NULL OR advance_percent BETWEEN 0 AND 100)',
                'suppliers ADD CONSTRAINT suppliers_lead_time_check CHECK (lead_time_days IS NULL OR lead_time_days BETWEEN 0 AND 180)',
                "suppliers ADD CONSTRAINT suppliers_pays_by_check CHECK (pays_by_method IS NULL OR pays_by_method IN ('cash','bkash','nagad','bank','card','other'))",
                "purchase_orders ADD CONSTRAINT purchase_orders_status_check CHECK (status IN ('draft','ordered','partially_received','received','closed','cancelled'))",
                "purchase_orders ADD CONSTRAINT purchase_orders_sent_via_check CHECK (sent_via IS NULL OR sent_via IN ('whatsapp','pdf','manual'))",
                'purchase_orders ADD CONSTRAINT purchase_orders_amounts_check CHECK (subtotal_amount >= 0 AND shipping_amount >= 0 AND discount_amount >= 0 AND discount_amount <= subtotal_amount + shipping_amount AND total_amount = subtotal_amount + shipping_amount - discount_amount AND received_value_amount >= 0 AND paid_amount >= 0)',
                'purchase_orders ADD CONSTRAINT purchase_orders_revision_check CHECK (revision >= 1)',
                'purchase_order_items ADD CONSTRAINT purchase_order_items_cost_check CHECK (unit_cost_amount BETWEEN 0 AND 1000000000)',
                'purchase_order_items ADD CONSTRAINT purchase_order_items_quantity_check CHECK (quantity_ordered BETWEEN 1 AND 100000 AND quantity_received >= 0 AND quantity_damaged >= 0 AND quantity_received + quantity_damaged <= quantity_ordered)',
                'purchase_receipt_items ADD CONSTRAINT purchase_receipt_items_quantity_check CHECK (quantity_received >= 0 AND quantity_damaged >= 0 AND quantity_received + quantity_damaged > 0 AND landed_unit_cost_amount >= 0)',
                'supplier_payments ADD CONSTRAINT supplier_payments_amount_check CHECK (amount BETWEEN 1 AND 10000000000)',
                "supplier_payments ADD CONSTRAINT supplier_payments_method_check CHECK (method IN ('cash','bkash','nagad','bank','card','other'))",
                "supplier_payments ADD CONSTRAINT supplier_payments_paid_on_check CHECK (paid_on >= DATE '2020-01-01')",
                'supplier_payments ADD CONSTRAINT supplier_payments_po_fk FOREIGN KEY (tenant_id, store_id, purchase_order_id) REFERENCES purchase_orders (tenant_id, store_id, id) ON DELETE SET NULL (purchase_order_id)',
            ] as $statement) {
                $db->statement("ALTER TABLE {$statement}");
            }
            foreach (['suppliers', 'purchase_orders', 'purchase_order_items', 'purchase_receipts', 'purchase_receipt_items', 'supplier_payments'] as $table) {
                RlsPolicies::enable($db, $table);
            }
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('supplier_payments');
        Schema::dropIfExists('purchase_receipt_items');
        Schema::dropIfExists('purchase_receipts');
        Schema::dropIfExists('purchase_order_items');
        Schema::dropIfExists('purchase_orders');
        Schema::dropIfExists('suppliers');
    }
};
