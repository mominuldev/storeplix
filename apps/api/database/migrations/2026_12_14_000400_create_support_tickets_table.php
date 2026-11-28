<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-9C §3.1 (P89C-14 – P89C-19): support tickets, tenant-owned [T] under forced RLS. `number` is a global
 * Postgres sequence from 1001 (`T-{number}`); on sqlite the service takes max + 1 inside its transaction. The order
 * link nulls only `order_id` when the order is deleted (PG 15+ column list), so `tenant_id` stays.
 */
return new class extends Migration
{
    public function up(): void
    {
        $pgsql = DB::getDriverName() === 'pgsql';

        Schema::create('support_tickets', function (Blueprint $table) use ($pgsql) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id')->nullable();
            $table->bigInteger('number')->unique();
            $table->foreignUlid('requester_id')->nullable()->constrained('users')->nullOnDelete();
            $table->string('category', 24);
            $table->string('subject', 150);
            $table->string('priority', 8)->default('normal');
            $table->string('status', 20)->default('open');
            $table->ulid('order_id')->nullable();
            $table->string('order_number', 32)->nullable();
            $table->foreignUlid('assignee_id')->nullable()->constrained('users')->nullOnDelete();
            $table->string('client_id', 36);
            $table->integer('messages_count')->default(0);
            $table->timestampTz('last_message_at');
            $table->timestampTz('last_merchant_reply_at')->nullable();
            $table->timestampTz('first_staff_reply_at')->nullable();
            $table->timestampTz('last_staff_reply_at')->nullable();
            $table->timestampTz('waiting_since')->nullable();
            $table->timestampTz('resolved_at')->nullable();
            $table->string('resolved_by_type', 8)->nullable();
            $table->timestampTz('closed_at')->nullable();
            $table->smallInteger('reopened_count')->default(0);
            $table->smallInteger('csat_rating')->nullable();
            $table->string('csat_comment', 500)->nullable();
            $table->timestampTz('csat_rated_at')->nullable();
            $table->integer('revision')->default(1);
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'client_id']);
            $table->index(['tenant_id', 'status', 'last_message_at']);
            $table->index(['status', 'waiting_since']);
            $table->index(['assignee_id', 'status']);
            $table->index('closed_at');
            $table->index(['tenant_id', 'order_id']);
            if (! $pgsql) {
                $table->foreign('store_id')->references('id')->on('stores')->nullOnDelete();
                $table->foreign('order_id')->references('id')->on('orders')->nullOnDelete();
            }
        });

        if (! $pgsql) {
            return;
        }
        $db = DB::connection();
        $db->statement('CREATE SEQUENCE IF NOT EXISTS support_ticket_number_seq START 1001');
        foreach ([
            'support_tickets ADD CONSTRAINT support_tickets_store_fk FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id) ON DELETE SET NULL (store_id)',
            'support_tickets ADD CONSTRAINT support_tickets_order_fk FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id) ON DELETE SET NULL (order_id)',
            "support_tickets ADD CONSTRAINT support_tickets_category_check CHECK (category IN ('orders_payments','shipping_couriers','products_inventory','storefront_domain','billing_plan','sms_marketing','account_access','bug','other'))",
            "support_tickets ADD CONSTRAINT support_tickets_priority_check CHECK (priority IN ('low','normal','high','urgent'))",
            "support_tickets ADD CONSTRAINT support_tickets_status_check CHECK (status IN ('open','awaiting_merchant','awaiting_support','resolved','closed'))",
            "support_tickets ADD CONSTRAINT support_tickets_resolved_by_check CHECK (resolved_by_type IS NULL OR resolved_by_type IN ('merchant','staff'))",
            'support_tickets ADD CONSTRAINT support_tickets_csat_check CHECK (csat_rating IS NULL OR csat_rating BETWEEN 1 AND 5)',
        ] as $statement) {
            $db->statement("ALTER TABLE {$statement}");
        }
        $db->statement('DROP INDEX IF EXISTS support_tickets_tenant_id_status_last_message_at_index');
        $db->statement('CREATE INDEX support_tickets_tenant_id_status_last_message_at_index ON support_tickets (tenant_id, status, last_message_at DESC)');
        $db->statement('CREATE INDEX support_tickets_subject_trgm ON support_tickets USING GIN (subject gin_trgm_ops)');
        if (RlsPolicies::roleExists($db, RlsPolicies::APP_ROLE)) {
            $db->statement('GRANT USAGE, SELECT ON SEQUENCE support_ticket_number_seq TO '.RlsPolicies::APP_ROLE);
        }
        if (RlsPolicies::roleExists($db, RlsPolicies::ADMIN_ROLE)) {
            $db->statement('GRANT USAGE, SELECT ON SEQUENCE support_ticket_number_seq TO '.RlsPolicies::ADMIN_ROLE);
        }
        RlsPolicies::enable($db, 'support_tickets');
    }

    public function down(): void
    {
        Schema::dropIfExists('support_tickets');
        if (DB::getDriverName() === 'pgsql') {
            DB::statement('DROP SEQUENCE IF EXISTS support_ticket_number_seq');
        }
    }
};
