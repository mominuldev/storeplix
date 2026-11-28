<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-9C §3.1 (P89C-2 – P89C-5, P89C-8): articles, their en/bn translations (editable draft fields + a separate
 * published snapshot) and slug redirects. Platform tables [P]: app role SELECT only. `search_vector` (Postgres only) is
 * rebuilt in code on publish (`simple` config, weights A title / B keywords / C summary / D body text); the trigram
 * index on the published title serves typo-tolerant search (pg_trgm is installed by an earlier migration).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('help_articles', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->string('slug', 80)->unique();
            $table->foreignUlid('category_id')->constrained('help_categories')->restrictOnDelete();
            $table->string('status', 10)->default('draft');
            $table->timestampTz('scheduled_at')->nullable();
            $table->jsonb('related_article_ids')->default('[]');
            $table->integer('helpful_yes')->default(0);
            $table->integer('helpful_no')->default(0);
            $table->timestampTz('first_published_at')->nullable();
            $table->timestampTz('last_published_at')->nullable();
            $table->foreignUlid('last_published_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampTz('archived_at')->nullable();
            $table->foreignUlid('archived_by')->nullable()->constrained('users')->nullOnDelete();
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->foreignUlid('updated_by')->nullable()->constrained('users')->nullOnDelete();
            $table->integer('revision')->default(1);
            $table->timestampsTz();

            $table->index(['status', 'category_id']);
            $table->index(['status', 'last_published_at']);
        });

        Schema::create('help_article_translations', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('article_id')->constrained('help_articles')->cascadeOnDelete();
            $table->char('language', 2);
            $table->string('title', 120)->default('');
            $table->string('summary', 160)->default('');
            $table->jsonb('body');
            $table->jsonb('keywords')->default('[]');
            $table->char('draft_hash', 64);
            $table->string('published_title', 120)->nullable();
            $table->string('published_summary', 160)->nullable();
            $table->jsonb('published_body')->nullable();
            $table->jsonb('published_keywords')->nullable();
            $table->char('published_hash', 64)->nullable();
            $table->timestampTz('published_at')->nullable();
            $table->text('body_text')->nullable();
            $table->integer('word_count')->default(0);
            $table->smallInteger('read_minutes')->default(1);
            $table->timestampsTz();

            $table->unique(['article_id', 'language']);
        });

        Schema::create('help_article_redirects', function (Blueprint $table) {
            $table->string('slug', 80)->primary();
            $table->foreignUlid('article_id')->constrained('help_articles')->cascadeOnDelete();
            $table->timestampTz('created_at')->nullable();

            $table->index('article_id');
        });

        $db = DB::connection();
        if ($db->getDriverName() !== 'pgsql') {
            return;
        }
        foreach ([
            "help_articles ADD CONSTRAINT help_articles_status_check CHECK (status IN ('draft','published','scheduled','archived'))",
            "help_articles ADD CONSTRAINT help_articles_scheduled_check CHECK (status <> 'scheduled' OR scheduled_at IS NOT NULL)",
            "help_articles ADD CONSTRAINT help_articles_slug_check CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')",
            'help_articles ADD CONSTRAINT help_articles_related_check CHECK (jsonb_typeof(related_article_ids) = \'array\' AND jsonb_array_length(related_article_ids) <= 5)',
            'help_articles ADD CONSTRAINT help_articles_helpful_check CHECK (helpful_yes >= 0 AND helpful_no >= 0)',
            "help_article_translations ADD CONSTRAINT help_article_translations_language_check CHECK (language IN ('en','bn'))",
            'help_article_translations ADD COLUMN search_vector tsvector',
        ] as $statement) {
            $db->statement("ALTER TABLE {$statement}");
        }
        $db->statement('DROP INDEX IF EXISTS help_articles_status_last_published_at_index');
        $db->statement('CREATE INDEX help_articles_status_last_published_at_index ON help_articles (status, last_published_at DESC)');
        $db->statement('CREATE INDEX help_article_translations_search ON help_article_translations USING GIN (search_vector)');
        $db->statement('CREATE INDEX help_article_translations_title_trgm ON help_article_translations USING GIN (published_title gin_trgm_ops)');

        if (RlsPolicies::roleExists($db, RlsPolicies::APP_ROLE)) {
            foreach (['help_articles', 'help_article_translations', 'help_article_redirects'] as $table) {
                $db->statement("REVOKE ALL ON {$table} FROM ".RlsPolicies::APP_ROLE);
                $db->statement("GRANT SELECT ON {$table} TO ".RlsPolicies::APP_ROLE);
            }
        }
    }

    public function down(): void
    {
        Schema::dropIfExists('help_article_redirects');
        Schema::dropIfExists('help_article_translations');
        Schema::dropIfExists('help_articles');
    }
};
