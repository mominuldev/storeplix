<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-9A §3.2 (P89A-20, ADR 0026 §4): `sms_messages` becomes the shop's SMS log. It stays a PLATFORM model
 * (nullable tenant_id for account codes, the Phase 2 special RLS policy unchanged) and gains: store_id (composite FK on
 * Postgres; null for account codes), kind, parts, charged_from, credits_charged, sender_id (caller ID used, null =
 * shared), body_preview (≤ 160, links as [link], never a code), error_code, sent_at, reference_type / reference_id
 * (soft ref). Status gains `skipped` with a CHECK (none existed).
 *
 * Back-fill (owner connection, BYPASSRLS): store_id = the tenant's single store, kind from purpose (P89A-4), sent_at =
 * updated_at for sent rows, campaign / automation references from `template` (`campaign:{id}[:test]`,
 * `automation:{id}`).
 */
return new class extends Migration
{
    private const TRANSACTIONAL = "'order_placed','order_confirmed','order_shipped','order_cancelled','order_updated','payment_link','pos_receipt','checkout_otp','sms_test'";

    public function up(): void
    {
        $pgsql = DB::getDriverName() === 'pgsql';

        Schema::table('sms_messages', function (Blueprint $table) {
            $table->char('store_id', 26)->nullable();
            $table->string('kind', 16)->nullable();
            $table->smallInteger('parts')->nullable();
            $table->string('charged_from', 10)->nullable();
            $table->integer('credits_charged')->default(0);
            $table->string('sender_id', 11)->nullable();
            $table->string('body_preview', 160)->nullable();
            $table->string('error_code', 32)->nullable();
            $table->timestampTz('sent_at')->nullable();
            $table->string('reference_type', 16)->nullable();
            $table->char('reference_id', 26)->nullable();
        });

        // Back-fill (one store per tenant).
        DB::statement('UPDATE sms_messages SET store_id = (SELECT stores.id FROM stores WHERE stores.tenant_id = sms_messages.tenant_id ORDER BY stores.created_at LIMIT 1) WHERE tenant_id IS NOT NULL');
        DB::statement('UPDATE sms_messages SET kind = \'transactional\' WHERE tenant_id IS NOT NULL AND purpose IN ('.self::TRANSACTIONAL.')');
        DB::statement("UPDATE sms_messages SET kind = 'marketing' WHERE tenant_id IS NOT NULL AND purpose IN ('campaign','automation')");
        DB::statement("UPDATE sms_messages SET sent_at = updated_at WHERE status = 'sent'");
        foreach (['campaign', 'automation'] as $type) {
            DB::table('sms_messages')->where('purpose', $type)->where('template', 'like', $type.':%')->select(['id', 'template'])
                ->orderBy('id')->chunk(1000, function ($rows) use ($type) {
                    foreach ($rows as $row) {
                        $id = explode(':', (string) $row->template)[1] ?? '';
                        if (strlen($id) === 26) {
                            DB::table('sms_messages')->where('id', $row->id)->update(['reference_type' => $type, 'reference_id' => strtolower($id)]);
                        }
                    }
                });
        }

        DB::statement('CREATE INDEX sms_messages_store_log_index ON sms_messages (tenant_id, store_id, created_at, id)');
        DB::statement('CREATE INDEX sms_messages_store_phone_index ON sms_messages (tenant_id, store_id, "to", created_at)');

        if ($pgsql) {
            $db = DB::connection();
            $db->statement('DROP INDEX IF EXISTS sms_messages_store_log_index');
            $db->statement('DROP INDEX IF EXISTS sms_messages_store_phone_index');
            $db->statement('CREATE INDEX sms_messages_store_log_index ON sms_messages (tenant_id, store_id, created_at DESC, id DESC)');
            $db->statement('CREATE INDEX sms_messages_store_phone_index ON sms_messages (tenant_id, store_id, "to", created_at DESC)');
            foreach ([
                'sms_messages ADD CONSTRAINT sms_messages_store_fk FOREIGN KEY (tenant_id, store_id) REFERENCES stores (tenant_id, id) ON DELETE CASCADE',
                "sms_messages ADD CONSTRAINT sms_messages_status_check CHECK (status IN ('queued','sent','failed','skipped'))",
                "sms_messages ADD CONSTRAINT sms_messages_kind_check CHECK (kind IS NULL OR kind IN ('transactional','marketing'))",
                "sms_messages ADD CONSTRAINT sms_messages_charged_from_check CHECK (charged_from IS NULL OR charged_from IN ('allowance','credits'))",
                'sms_messages ADD CONSTRAINT sms_messages_credits_charged_check CHECK (credits_charged >= 0)',
                "sms_messages ADD CONSTRAINT sms_messages_reference_type_check CHECK (reference_type IS NULL OR reference_type IN ('order','pos_sale','campaign','automation'))",
            ] as $statement) {
                $db->statement("ALTER TABLE {$statement}");
            }
        }
    }

    public function down(): void
    {
        if (DB::getDriverName() === 'pgsql') {
            $db = DB::connection();
            foreach (['sms_messages_store_fk', 'sms_messages_status_check', 'sms_messages_kind_check', 'sms_messages_charged_from_check',
                'sms_messages_credits_charged_check', 'sms_messages_reference_type_check'] as $name) {
                $db->statement("ALTER TABLE sms_messages DROP CONSTRAINT IF EXISTS {$name}");
            }
            $db->statement("UPDATE sms_messages SET status = 'failed' WHERE status = 'skipped'");
        }
        DB::statement('DROP INDEX IF EXISTS sms_messages_store_log_index');
        DB::statement('DROP INDEX IF EXISTS sms_messages_store_phone_index');
        Schema::table('sms_messages', function (Blueprint $table) {
            $table->dropColumn(['store_id', 'kind', 'parts', 'charged_from', 'credits_charged', 'sender_id', 'body_preview',
                'error_code', 'sent_at', 'reference_type', 'reference_id']);
        });
    }
};
