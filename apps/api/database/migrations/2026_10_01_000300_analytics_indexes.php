<?php

declare(strict_types=1);

use Illuminate\Database\Migrations\Migration;
use Illuminate\Support\Facades\DB;

/**
 * PHASE-8-2-CONTRACT §5.1 000300: platform indexes for the analytics reads on the admin connection (deliberately not tenant-led):
 * the night job's orders-per-day scan, first/lifetime paid invoices per tenant and trial ends. Postgres builds them
 * CONCURRENTLY (outside a transaction) and only if missing; sqlite gets plain (partial) indexes. Forward-only.
 */
return new class extends Migration
{
    public $withinTransaction = false;

    private const INDEXES = [
        'orders_placed_at_index' => 'orders (placed_at)',
        'billing_invoices_paid_tenant_index' => "billing_invoices (tenant_id, paid_at) WHERE status = 'paid'",
        'subscriptions_trial_ends_at_index' => 'subscriptions (trial_ends_at) WHERE trial_ends_at IS NOT NULL',
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
