<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-7-CONTRACT §4: the expenses ledger. `expense_recurrences` ("Repeat every month" series) first, then
 * `expenses`. Both store-scoped [S] with the composite store FK (tenant_id, store_id) → stores(tenant_id, id).
 * `expenses.recurrence_id` survives its recurrence via `ON DELETE SET NULL (recurrence_id)` on Postgres (plain SET NULL
 * would null tenant_id/store_id too); sqlite gets a single-column FK. The receipt FK (tenant_id, receipt_media_id) →
 * media is NO ACTION (restrict, checked at statement end so tenant/store cascades still work): a receipt attached to an
 * expense can't be deleted (the prune race backstop, §9). RLS forced on both (RlsTables::TENANT).
 */
return new class extends Migration
{
    public function up(): void
    {
        $pgsql = DB::getDriverName() === 'pgsql';

        Schema::create('expense_recurrences', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->smallInteger('day_of_month');
            $table->date('next_on');
            $table->string('status', 8)->default('active');
            $table->timestampTz('stopped_at')->nullable();
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'status']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });

        Schema::create('expenses', function (Blueprint $table) use ($pgsql) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('category', 16);
            $table->string('paid_from', 8);
            $table->bigInteger('amount');
            $table->char('currency', 3);
            $table->date('spent_on');
            $table->string('note', 200)->nullable();
            $table->char('receipt_media_id', 26)->nullable()->unique();
            $table->ulid('recurrence_id')->nullable();
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->foreignUlid('updated_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();

            $table->unique(['tenant_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'spent_on', 'id'], 'expenses_list_index');
            $table->index(['tenant_id', 'store_id', 'spent_on', 'category'], 'expenses_report_index');
            $table->index('recurrence_id');
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
            $table->foreign(['tenant_id', 'receipt_media_id'])->references(['tenant_id', 'id'])->on('media');
            if (! $pgsql) {
                $table->foreign('recurrence_id')->references('id')->on('expense_recurrences')->nullOnDelete();
            }
        });

        $db = DB::connection();
        // Generator idempotency (§6.2): one occurrence per (recurrence, date). Due active series (scheduler discovery).
        $db->statement('CREATE UNIQUE INDEX expenses_recurrence_spent_on_unique ON expenses (recurrence_id, spent_on) WHERE recurrence_id IS NOT NULL');
        $db->statement("CREATE INDEX expense_recurrences_active_next_on_index ON expense_recurrences (next_on) WHERE status = 'active'");

        if ($pgsql) {
            // §4: the list index reads newest first; the report index covers `amount`.
            $db->statement('DROP INDEX IF EXISTS expenses_list_index');
            $db->statement('CREATE INDEX expenses_list_index ON expenses (tenant_id, store_id, spent_on DESC, id DESC)');
            $db->statement('DROP INDEX IF EXISTS expenses_report_index');
            $db->statement('CREATE INDEX expenses_report_index ON expenses (tenant_id, store_id, spent_on, category) INCLUDE (amount)');
            foreach ([
                'expense_recurrences ADD CONSTRAINT expense_recurrences_day_check CHECK (day_of_month BETWEEN 1 AND 31)',
                "expense_recurrences ADD CONSTRAINT expense_recurrences_status_check CHECK (status IN ('active','stopped'))",
                "expenses ADD CONSTRAINT expenses_category_check CHECK (category IN ('ads','packaging','salaries','rent_bills','courier','other'))",
                "expenses ADD CONSTRAINT expenses_paid_from_check CHECK (paid_from IN ('cash','bank','card','bkash','nagad','other'))",
                'expenses ADD CONSTRAINT expenses_amount_check CHECK (amount > 0 AND amount <= 1000000000)',
                'expenses ADD CONSTRAINT expenses_recurrence_fk FOREIGN KEY (tenant_id, store_id, recurrence_id) REFERENCES expense_recurrences (tenant_id, store_id, id) ON DELETE SET NULL (recurrence_id)',
            ] as $statement) {
                $db->statement("ALTER TABLE {$statement}");
            }
            foreach (['expense_recurrences', 'expenses'] as $table) {
                RlsPolicies::enable($db, $table);
            }
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('expenses');
        Schema::dropIfExists('expense_recurrences');
    }
};
