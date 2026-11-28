<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-9C §3.1 (P89C-15, P89C-18): ticket messages (immutable; kinds merchant / staff / note / system; `client_id`
 * makes sends idempotent) and attachments (a private `media` row, purpose `support_attachment`, RESTRICT). Both [T]
 * under forced RLS. Note rows and note attachments are staff-only (S251).
 */
return new class extends Migration
{
    public function up(): void
    {
        $pgsql = DB::getDriverName() === 'pgsql';

        Schema::create('support_ticket_messages', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('ticket_id');
            $table->string('kind', 8);
            $table->foreignUlid('author_user_id')->nullable()->constrained('users')->nullOnDelete();
            $table->text('body')->nullable();
            $table->string('system_event', 20)->nullable();
            $table->jsonb('system_meta')->nullable();
            $table->string('client_id', 36)->nullable();
            $table->timestampTz('created_at')->nullable();

            $table->unique(['tenant_id', 'id']);
            $table->index(['tenant_id', 'ticket_id', 'id']);
            $table->foreign(['tenant_id', 'ticket_id'])->references(['tenant_id', 'id'])->on('support_tickets')->cascadeOnDelete();
        });
        DB::statement('CREATE UNIQUE INDEX support_ticket_messages_client_unique ON support_ticket_messages (ticket_id, client_id) WHERE client_id IS NOT NULL');

        Schema::create('support_ticket_attachments', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('ticket_id')->nullable();
            $table->ulid('message_id')->nullable();
            $table->char('media_id', 26)->unique();
            $table->string('uploaded_by_type', 8);
            $table->foreignUlid('uploaded_by_user_id')->nullable()->constrained('users')->nullOnDelete();
            $table->string('filename', 160);
            $table->string('mime', 32);
            $table->integer('size_bytes');
            $table->timestampTz('created_at')->nullable();

            $table->unique(['tenant_id', 'id']);
            $table->index(['tenant_id', 'ticket_id']);
            $table->index(['tenant_id', 'message_id']);
            $table->foreign(['tenant_id', 'ticket_id'])->references(['tenant_id', 'id'])->on('support_tickets')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'message_id'])->references(['tenant_id', 'id'])->on('support_ticket_messages')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'media_id'])->references(['tenant_id', 'id'])->on('media');
        });

        if (! $pgsql) {
            return;
        }
        $db = DB::connection();
        foreach ([
            "support_ticket_messages ADD CONSTRAINT support_ticket_messages_kind_check CHECK (kind IN ('merchant','staff','note','system'))",
            "support_ticket_messages ADD CONSTRAINT support_ticket_messages_body_check CHECK ((body IS NULL AND kind = 'system') OR (body IS NOT NULL AND char_length(body) <= 5000))",
            "support_ticket_messages ADD CONSTRAINT support_ticket_messages_system_event_check CHECK (system_event IS NULL OR system_event IN ('created','assigned','unassigned','status_changed','priority_changed','category_changed','reopened','rated','auto_closed'))",
            "support_ticket_attachments ADD CONSTRAINT support_ticket_attachments_uploaded_by_check CHECK (uploaded_by_type IN ('merchant','staff'))",
            "support_ticket_attachments ADD CONSTRAINT support_ticket_attachments_mime_check CHECK (mime IN ('image/jpeg','image/png','application/pdf'))",
            'support_ticket_attachments ADD CONSTRAINT support_ticket_attachments_size_check CHECK (size_bytes >= 0 AND size_bytes <= 10485760)',
        ] as $statement) {
            $db->statement("ALTER TABLE {$statement}");
        }
        RlsPolicies::enable($db, 'support_ticket_messages');
        RlsPolicies::enable($db, 'support_ticket_attachments');
    }

    public function down(): void
    {
        Schema::dropIfExists('support_ticket_attachments');
        Schema::dropIfExists('support_ticket_messages');
    }
};
