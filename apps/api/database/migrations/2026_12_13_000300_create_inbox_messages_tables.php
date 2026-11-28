<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-8E §3: messages (immutable; `client_id` makes sends idempotent, `email_message_id` dedupes inbound mail) and
 * attachments (a private `media` row, purpose `inbox_attachment`, referenced through (tenant_id, id) with RESTRICT;
 * no CHECK on media.purpose exists). Both store-scoped [S] under forced RLS. The saved-reply FK of an attachment is
 * added with inbox_saved_replies (000500).
 */
return new class extends Migration
{
    public function up(): void
    {
        $pgsql = DB::getDriverName() === 'pgsql';

        Schema::create('inbox_messages', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->ulid('conversation_id');
            $table->string('kind', 8);
            $table->foreignUlid('author_user_id')->nullable()->constrained('users')->nullOnDelete();
            $table->text('body')->nullable();
            $table->string('system_event', 16)->nullable();
            $table->jsonb('system_meta')->nullable();
            $table->string('client_id', 36)->nullable();
            $table->string('delivery_status', 8)->nullable();
            $table->string('sms_status', 16)->nullable(); // contract says 12, but 'not_applicable' is 14
            $table->char('sms_message_id', 26)->nullable();
            $table->string('email_message_id', 255)->nullable();
            $table->char('saved_reply_id', 26)->nullable();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->index(['tenant_id', 'conversation_id', 'id']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'conversation_id'])->references(['tenant_id', 'id'])->on('inbox_conversations')->cascadeOnDelete();
        });
        DB::statement('CREATE UNIQUE INDEX inbox_messages_client_unique ON inbox_messages (conversation_id, client_id) WHERE client_id IS NOT NULL');
        DB::statement('CREATE UNIQUE INDEX inbox_messages_email_unique ON inbox_messages (store_id, email_message_id) WHERE email_message_id IS NOT NULL');

        Schema::create('inbox_attachments', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->char('media_id', 26)->unique();
            $table->ulid('message_id')->nullable();
            $table->ulid('saved_reply_id')->nullable();
            $table->string('uploaded_by_type', 8);
            $table->foreignUlid('uploaded_by_user_id')->nullable()->constrained('users')->nullOnDelete();
            $table->char('widget_session_id', 26)->nullable();
            $table->string('filename', 160);
            $table->string('mime', 32);
            $table->integer('size_bytes');
            $table->timestampTz('created_at')->nullable();

            $table->unique(['tenant_id', 'id']);
            $table->index(['tenant_id', 'message_id']);
            $table->index(['tenant_id', 'saved_reply_id']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'media_id'])->references(['tenant_id', 'id'])->on('media');
            $table->foreign(['tenant_id', 'message_id'])->references(['tenant_id', 'id'])->on('inbox_messages')->cascadeOnDelete();
        });

        if (! $pgsql) {
            return;
        }
        $db = DB::connection();
        foreach ([
            "inbox_messages ADD CONSTRAINT inbox_messages_kind_check CHECK (kind IN ('customer','reply','note','system'))",
            "inbox_messages ADD CONSTRAINT inbox_messages_body_check CHECK ((body IS NULL AND kind = 'system') OR (body IS NOT NULL AND char_length(body) <= 4000))",
            "inbox_messages ADD CONSTRAINT inbox_messages_system_event_check CHECK (system_event IS NULL OR system_event IN ('assigned','unassigned','pending','closed','reopened','order_linked','order_unlinked','blocked','unblocked'))",
            "inbox_messages ADD CONSTRAINT inbox_messages_delivery_status_check CHECK (delivery_status IS NULL OR delivery_status IN ('queued','sent','failed'))",
            "inbox_messages ADD CONSTRAINT inbox_messages_sms_status_check CHECK (sms_status IS NULL OR sms_status IN ('pending','sent','seen','throttled','no_credits','failed','not_applicable'))",
            "inbox_attachments ADD CONSTRAINT inbox_attachments_uploaded_by_check CHECK (uploaded_by_type IN ('user','shopper','email'))",
            "inbox_attachments ADD CONSTRAINT inbox_attachments_mime_check CHECK (mime IN ('image/jpeg','image/png','application/pdf'))",
            'inbox_attachments ADD CONSTRAINT inbox_attachments_size_check CHECK (size_bytes >= 0 AND size_bytes <= 5242880)',
            'inbox_attachments ADD CONSTRAINT inbox_attachments_owner_check CHECK (NOT (message_id IS NOT NULL AND saved_reply_id IS NOT NULL))',
        ] as $statement) {
            $db->statement("ALTER TABLE {$statement}");
        }
        RlsPolicies::enable($db, 'inbox_messages');
        RlsPolicies::enable($db, 'inbox_attachments');
    }

    public function down(): void
    {
        Schema::dropIfExists('inbox_attachments');
        Schema::dropIfExists('inbox_messages');
    }
};
