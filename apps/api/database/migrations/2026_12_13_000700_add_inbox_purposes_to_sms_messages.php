<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * PHASE-8-8E §3 (amends PHASE-8-9A §3.4): `sms_messages.reference_type` may be `conversation` (the `inbox_reply` SMS).
 * The purposes `inbox_verify` / `inbox_reply` need no schema change (purpose has no CHECK). Postgres only.
 */
return new class extends Migration
{
    public function up(): void
    {
        if (DB::getDriverName() !== 'pgsql') {
            return;
        }
        DB::statement('ALTER TABLE sms_messages DROP CONSTRAINT IF EXISTS sms_messages_reference_type_check');
        DB::statement("ALTER TABLE sms_messages ADD CONSTRAINT sms_messages_reference_type_check CHECK (reference_type IS NULL OR reference_type IN ('order','pos_sale','campaign','automation','conversation'))");
    }

    public function down(): void
    {
        if (DB::getDriverName() !== 'pgsql') {
            return;
        }
        DB::statement('ALTER TABLE sms_messages DROP CONSTRAINT IF EXISTS sms_messages_reference_type_check');
        DB::statement("ALTER TABLE sms_messages ADD CONSTRAINT sms_messages_reference_type_check CHECK (reference_type IS NULL OR reference_type IN ('order','pos_sale','campaign','automation'))");
    }
};
