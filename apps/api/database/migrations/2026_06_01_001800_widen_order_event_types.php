<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/** PHASE-5B-CONTRACT §3 001800: order_events.type gains payment_link, items_edited, return, document. Postgres CHECK only. */
return new class extends Migration
{
    public function up(): void
    {
        if (DB::getDriverName() !== 'pgsql') {
            return;
        }
        DB::statement('ALTER TABLE order_events DROP CONSTRAINT IF EXISTS order_events_type_check');
        DB::statement("ALTER TABLE order_events ADD CONSTRAINT order_events_type_check CHECK (type IN ('placed','status_changed','note','edited','payment','refund','shipment','notification','coupon_released','payment_link','items_edited','return','document'))");
    }

    public function down(): void
    {
        if (DB::getDriverName() !== 'pgsql') {
            return;
        }
        // order_events are append-only history; the narrower CHECK is re-added NOT VALID so existing 5b rows survive.
        DB::statement('ALTER TABLE order_events DROP CONSTRAINT IF EXISTS order_events_type_check');
        DB::statement("ALTER TABLE order_events ADD CONSTRAINT order_events_type_check CHECK (type IN ('placed','status_changed','note','edited','payment','refund','shipment','notification','coupon_released')) NOT VALID");
    }
};
