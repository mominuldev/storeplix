<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-8E §3 (P88E-2): one conversation per contact per channel thread, U(store_id, channel, thread_key) — the
 * ON CONFLICT target of the race-free create (§3.1). Store-scoped [S], forced RLS. customer / order links null out when
 * those rows go (customer deletion unlinks, P88E-18). Also ships `sp_inbox_route(kind, key)`, the SECURITY DEFINER
 * pre-tenant lookup of the inbound email webhook (§11.2 step 3): ids only.
 */
return new class extends Migration
{
    public function up(): void
    {
        $pgsql = DB::getDriverName() === 'pgsql';

        Schema::create('inbox_conversations', function (Blueprint $table) use ($pgsql) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('channel', 8);
            $table->string('thread_key', 300);
            $table->string('status', 8)->default('open');
            $table->string('identity', 16);
            $table->foreignUlid('assignee_id')->nullable()->constrained('users')->nullOnDelete();
            $table->ulid('customer_id')->nullable();
            $table->ulid('order_id')->nullable();
            $table->string('contact_name', 120);
            $table->string('contact_phone', 15)->nullable();
            $table->string('contact_email', 254)->nullable();
            $table->string('subject', 200)->nullable();
            $table->jsonb('context')->nullable();
            $table->string('source_path', 300)->nullable();
            $table->string('preview', 160)->default('');
            $table->timestampTz('last_message_at');
            $table->char('last_customer_message_id', 26)->nullable();
            $table->timestampTz('last_customer_message_at')->nullable();
            $table->timestampTz('first_response_at')->nullable();
            $table->string('last_inbound_message_id', 255)->nullable();
            $table->timestampTz('reply_sms_sent_at')->nullable();
            $table->timestampTz('customer_seen_at')->nullable();
            $table->timestampTz('closed_at')->nullable();
            $table->foreignUlid('closed_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampTz('blocked_at')->nullable();
            $table->foreignUlid('blocked_by')->nullable()->constrained('users')->nullOnDelete();
            $table->integer('messages_count')->default(0);
            $table->integer('revision')->default(1);
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['store_id', 'channel', 'thread_key'], 'inbox_conversations_thread_unique');
            $table->index(['tenant_id', 'store_id', 'status', 'last_message_at', 'id'], 'inbox_conversations_list_index');
            $table->index(['tenant_id', 'store_id', 'assignee_id', 'status'], 'inbox_conversations_assignee_index');
            $table->index(['tenant_id', 'customer_id']);
            $table->index(['tenant_id', 'order_id']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            if (! $pgsql) {
                $table->foreign('customer_id')->references('id')->on('customers')->nullOnDelete();
                $table->foreign('order_id')->references('id')->on('orders')->nullOnDelete();
            }
        });

        if (! $pgsql) {
            return;
        }
        $db = DB::connection();
        // Composite FKs with SET NULL on the referencing column only (PG 15+ column list), so tenant_id stays.
        foreach ([
            'inbox_conversations ADD CONSTRAINT inbox_conversations_customer_fk FOREIGN KEY (tenant_id, customer_id) REFERENCES customers (tenant_id, id) ON DELETE SET NULL (customer_id)',
            'inbox_conversations ADD CONSTRAINT inbox_conversations_order_fk FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id) ON DELETE SET NULL (order_id)',
            "inbox_conversations ADD CONSTRAINT inbox_conversations_channel_check CHECK (channel IN ('web_chat','order','email'))",
            "inbox_conversations ADD CONSTRAINT inbox_conversations_status_check CHECK (status IN ('open','pending','closed'))",
            "inbox_conversations ADD CONSTRAINT inbox_conversations_identity_check CHECK (identity IN ('verified_phone','order_access','email','email_unverified','unverified'))",
        ] as $statement) {
            $db->statement("ALTER TABLE {$statement}");
        }
        $db->statement('DROP INDEX IF EXISTS inbox_conversations_list_index');
        $db->statement('CREATE INDEX inbox_conversations_list_index ON inbox_conversations (tenant_id, store_id, status, last_message_at DESC, id DESC)');
        $db->statement('CREATE INDEX inbox_conversations_contact_trgm ON inbox_conversations USING GIN (contact_name gin_trgm_ops)');
        RlsPolicies::enable($db, 'inbox_conversations');

        // §11.2 step 3: inbound mail → ids only (kind: store key | conversation id | order id). Owned by the migrating role.
        $db->statement(<<<'SQL'
            CREATE OR REPLACE FUNCTION sp_inbox_route(p_kind text, p_key text)
              RETURNS TABLE (tenant_id text, store_id text, target_id text)
              LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp
            AS $$
              SELECT s.tenant_id::text, s.store_id::text, s.id::text FROM inbox_settings s
               WHERE p_kind = 'store' AND s.email_key = p_key
              UNION ALL
              SELECT c.tenant_id::text, c.store_id::text, c.id::text FROM inbox_conversations c
               WHERE p_kind = 'conversation' AND c.id = p_key::bpchar
              UNION ALL
              SELECT o.tenant_id::text, o.store_id::text, o.id::text FROM orders o
               WHERE p_kind = 'order' AND o.id = p_key::bpchar
              LIMIT 1
            $$
            SQL);
        $db->statement('REVOKE ALL ON FUNCTION sp_inbox_route(text, text) FROM PUBLIC');
        if (RlsPolicies::roleExists($db, RlsPolicies::APP_ROLE)) {
            $db->statement('GRANT EXECUTE ON FUNCTION sp_inbox_route(text, text) TO '.RlsPolicies::APP_ROLE);
        }
    }

    public function down(): void
    {
        if (DB::getDriverName() === 'pgsql') {
            DB::statement('DROP FUNCTION IF EXISTS sp_inbox_route(text, text)');
        }
        Schema::dropIfExists('inbox_conversations');
    }
};
