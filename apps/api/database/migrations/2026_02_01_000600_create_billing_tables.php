<?php

use Database\Seeders\PlanSeeder;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Str;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('plans', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->string('code', 32)->unique();
            $table->string('name');
            $table->bigInteger('price_amount');
            $table->char('currency', 3);
            $table->string('interval', 8)->default('month');
            $table->jsonb('limits');
            $table->jsonb('features');
            $table->boolean('is_active')->default(true);
            $table->smallInteger('sort')->default(0);
            $table->timestamps();
        });

        Schema::create('subscriptions', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->foreignUlid('plan_id')->constrained('plans')->restrictOnDelete();
            $table->string('status', 16);
            $table->timestamp('trial_ends_at')->nullable();
            $table->timestamp('current_period_start')->nullable();
            $table->timestamp('current_period_end')->nullable();
            $table->boolean('cancel_at_period_end')->default(false);
            $table->timestamps();

            $table->unique(['tenant_id', 'id']);
        });

        DB::statement("CREATE UNIQUE INDEX subscriptions_one_current ON subscriptions (tenant_id) WHERE status IN ('trialing','active','past_due')");

        // Plans are reference data the backfill depends on.
        (new PlanSeeder)->run();

        // Backfill: every existing tenant without a subscription starts a 14-day Starter trial.
        $starter = DB::table('plans')->where('code', 'starter')->value('id');
        $now = now();

        DB::table('tenants')
            ->whereNotExists(fn ($q) => $q->select(DB::raw(1))->from('subscriptions')->whereColumn('subscriptions.tenant_id', 'tenants.id'))
            ->orderBy('id')
            ->pluck('id')
            ->each(fn (string $tenantId) => DB::table('subscriptions')->insert([
                'id' => strtolower((string) Str::ulid()),
                'tenant_id' => $tenantId,
                'plan_id' => $starter,
                'status' => 'trialing',
                'trial_ends_at' => $now->copy()->addDays(14),
                'cancel_at_period_end' => false,
                'created_at' => $now,
                'updated_at' => $now,
            ]));
    }

    public function down(): void
    {
        Schema::dropIfExists('subscriptions');
        Schema::dropIfExists('plans');
    }
};
