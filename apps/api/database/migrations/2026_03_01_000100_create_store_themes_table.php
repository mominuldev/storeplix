<?php

use App\Domain\Themes\ThemeConfigUpgrader;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;
use Illuminate\Support\Str;

/**
 * Phase 3 (P3-14): theme config moves from store_settings.theme to store_themes (draft + published).
 * Every existing store gets an active row (normalised to 1.1.0, draft = published), then the column is dropped.
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('store_themes', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->foreignUlid('tenant_id')->constrained('tenants')->cascadeOnDelete();
            $table->ulid('store_id');
            $table->string('theme_code', 64);
            $table->string('theme_version', 20);
            $table->jsonb('draft_config');
            $table->unsignedInteger('draft_revision')->default(1);
            $table->timestampTz('draft_updated_at')->nullable();
            $table->foreignUlid('draft_updated_by')->nullable()->constrained('users')->nullOnDelete();
            $table->jsonb('published_config')->nullable();
            $table->unsignedInteger('published_revision')->nullable();
            $table->timestampTz('published_at')->nullable();
            $table->foreignUlid('published_by')->nullable()->constrained('users')->nullOnDelete();
            $table->boolean('is_active')->default(false);
            $table->timestampTz('applied_at')->nullable();
            $table->timestamps();

            $table->unique(['tenant_id', 'id']);
            $table->unique(['store_id', 'theme_code']);
            $table->index(['tenant_id', 'store_id']);
            $table->foreign(['tenant_id', 'store_id'])->references(['tenant_id', 'id'])->on('stores')->cascadeOnDelete();
        });

        DB::statement('CREATE UNIQUE INDEX store_themes_one_active ON store_themes (store_id) WHERE is_active');

        $this->copyFromStoreSettings();

        Schema::table('store_settings', function (Blueprint $table) {
            $table->dropColumn('theme');
        });
    }

    public function down(): void
    {
        Schema::table('store_settings', function (Blueprint $table) {
            $table->json('theme')->nullable();
        });

        $active = DB::table('store_themes')->where('is_active', true)->get(['store_id', 'published_config', 'draft_config']);
        foreach ($active as $row) {
            DB::table('store_settings')->where('store_id', $row->store_id)
                ->update(['theme' => $row->published_config ?? $row->draft_config]);
        }

        Schema::dropIfExists('store_themes');
    }

    private function copyFromStoreSettings(): void
    {
        $rows = DB::table('store_settings')->get(['tenant_id', 'store_id', 'theme']);
        if ($rows->isEmpty()) {
            return;
        }

        $upgrader = app(ThemeConfigUpgrader::class);
        $now = now();

        foreach ($rows as $row) {
            $old = json_decode((string) $row->theme, true);
            $config = $upgrader->toV1_1(is_array($old) ? $old : []);
            $json = json_encode($config, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);

            DB::table('store_themes')->insert([
                'id' => strtolower((string) Str::ulid()),
                'tenant_id' => $row->tenant_id,
                'store_id' => $row->store_id,
                'theme_code' => $config['theme'],
                'theme_version' => $config['version'],
                'draft_config' => $json,
                'draft_revision' => 1,
                'draft_updated_at' => $now,
                'published_config' => $json,
                'published_revision' => 1,
                'published_at' => $now,
                'is_active' => true,
                'created_at' => $now,
                'updated_at' => $now,
            ]);
        }
    }
};
