<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-9C §3.1 (P89C-9, P89C-11): "Was this helpful?" votes (one per user per article; `tenant_id` is context for
 * staff stats, NOT an RLS owner: RlsTables::PLATFORM_SUBJECT) and per-day view counters. Platform tables [P]; the app
 * role writes its own vote rows (user id checked in code) and upserts view counters.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('help_article_feedback', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('article_id')->constrained('help_articles')->cascadeOnDelete();
            $table->foreignUlid('user_id')->constrained('users')->cascadeOnDelete();
            $table->foreignUlid('tenant_id')->nullable()->constrained('tenants')->nullOnDelete();
            $table->char('language', 2);
            $table->boolean('helpful');
            $table->string('reason', 20)->nullable();
            $table->string('note', 500)->nullable();
            $table->timestampsTz();

            $table->unique(['article_id', 'user_id']);
            $table->index(['article_id', 'updated_at']);
        });

        Schema::create('help_article_daily_views', function (Blueprint $table) {
            $table->foreignUlid('article_id')->constrained('help_articles')->cascadeOnDelete();
            $table->date('day');
            $table->integer('views')->default(0);

            $table->primary(['article_id', 'day']);
            $table->index('day');
        });

        $db = DB::connection();
        if ($db->getDriverName() !== 'pgsql') {
            return;
        }
        foreach ([
            "help_article_feedback ADD CONSTRAINT help_article_feedback_language_check CHECK (language IN ('en','bn'))",
            "help_article_feedback ADD CONSTRAINT help_article_feedback_reason_check CHECK (reason IS NULL OR reason IN ('steps_mismatch','hard_to_follow','out_of_date','not_my_question'))",
            'help_article_feedback ADD CONSTRAINT help_article_feedback_reason_no_check CHECK (helpful = false OR reason IS NULL)',
        ] as $statement) {
            $db->statement("ALTER TABLE {$statement}");
        }
        $db->statement('DROP INDEX IF EXISTS help_article_feedback_article_id_updated_at_index');
        $db->statement('CREATE INDEX help_article_feedback_article_id_updated_at_index ON help_article_feedback (article_id, updated_at DESC)');

        if (RlsPolicies::roleExists($db, RlsPolicies::APP_ROLE)) {
            $app = RlsPolicies::APP_ROLE;
            $db->statement("REVOKE ALL ON help_article_feedback FROM {$app}");
            $db->statement("GRANT SELECT, INSERT, UPDATE, DELETE ON help_article_feedback TO {$app}");
            $db->statement("REVOKE ALL ON help_article_daily_views FROM {$app}");
            $db->statement("GRANT SELECT, INSERT, UPDATE ON help_article_daily_views TO {$app}");
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('help_article_daily_views');
        Schema::dropIfExists('help_article_feedback');
    }
};
