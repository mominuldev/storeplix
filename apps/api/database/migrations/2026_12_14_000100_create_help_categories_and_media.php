<?php

declare(strict_types=1);

use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-8-9C §3.1 (ADR 0029): help categories and platform help images. Platform tables [P] (no tenant_id, no RLS;
 * RlsTables::PLATFORM). The app role may only SELECT; every staff write runs on the platform connection (PlatformDb).
 */
return new class extends Migration
{
    public function up(): void
    {
        Schema::create('help_categories', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->string('slug', 60)->unique();
            $table->string('name_en', 60);
            $table->string('name_bn', 60)->nullable();
            $table->string('description_en', 160)->nullable();
            $table->string('description_bn', 160)->nullable();
            $table->string('icon', 16);
            $table->integer('position')->default(0);
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
            $table->foreignUlid('updated_by')->nullable()->constrained('users')->nullOnDelete();
            $table->integer('revision')->default(1);
            $table->timestampsTz();

            $table->index('position');
        });

        Schema::create('help_media', function (Blueprint $table) {
            $table->ulid('id')->primary();
            $table->string('disk', 16);
            $table->string('path', 255);
            $table->string('mime', 32);
            $table->integer('size_bytes');
            $table->integer('width')->default(0);
            $table->integer('height')->default(0);
            $table->jsonb('variants')->default('[]');
            $table->string('status', 10)->default('processing');
            $table->string('alt', 200)->nullable();
            $table->foreignUlid('uploaded_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestampsTz();

            $table->index(['status', 'created_at']);
        });

        $db = DB::connection();
        if ($db->getDriverName() !== 'pgsql') {
            return;
        }
        foreach ([
            "help_categories ADD CONSTRAINT help_categories_slug_check CHECK (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$')",
            "help_categories ADD CONSTRAINT help_categories_icon_check CHECK (icon IN ('rocket','box','cart','truck','card','palette','megaphone','globe','users','chart','settings','message'))",
            "help_media ADD CONSTRAINT help_media_mime_check CHECK (mime IN ('image/png','image/jpeg','image/webp'))",
            'help_media ADD CONSTRAINT help_media_size_check CHECK (size_bytes >= 0 AND size_bytes <= 5242880)',
            "help_media ADD CONSTRAINT help_media_status_check CHECK (status IN ('processing','ready','failed'))",
        ] as $statement) {
            $db->statement("ALTER TABLE {$statement}");
        }
        if (RlsPolicies::roleExists($db, RlsPolicies::APP_ROLE)) {
            foreach (['help_categories', 'help_media'] as $table) {
                $db->statement("REVOKE ALL ON {$table} FROM ".RlsPolicies::APP_ROLE);
                $db->statement("GRANT SELECT ON {$table} TO ".RlsPolicies::APP_ROLE);
            }
        }
    }

    public function down(): void
    {
        // Forward-only once merged (CLAUDE.md); down() exists for local rollbacks only.
        Schema::dropIfExists('help_media');
        Schema::dropIfExists('help_categories');
    }
};
