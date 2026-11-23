<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * PHASE-7-CONTRACT §5.1 000700: report indexes that don't exist yet. `orders (tenant_id, store_id, placed_at)` already
 * exists (orders migration). Postgres builds them CONCURRENTLY (outside a transaction); sqlite gets plain partial
 * indexes. Forward-only; down() drops them.
 */
return new class extends Migration
{
    public $withinTransaction = false;

    private const INDEXES = [
        'orders_report_delivered_idx' => 'orders (tenant_id, store_id, delivered_at) WHERE delivered_at IS NOT NULL',
        'shipments_report_booked_idx' => 'shipments (tenant_id, store_id, booked_at) WHERE booked_at IS NOT NULL',
        'return_requests_report_created_idx' => 'return_requests (tenant_id, store_id, created_at)',
    ];

    public function up(): void
    {
        $concurrently = DB::getDriverName() === 'pgsql' ? 'CONCURRENTLY ' : '';
        foreach (self::INDEXES as $name => $definition) {
            DB::statement("CREATE INDEX {$concurrently}IF NOT EXISTS {$name} ON {$definition}");
        }
    }

    public function down(): void
    {
        foreach (array_keys(self::INDEXES) as $name) {
            DB::statement("DROP INDEX IF EXISTS {$name}");
        }
    }
};
