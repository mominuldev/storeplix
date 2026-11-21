<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('store_settings', function (Blueprint $table) {
            $table->ulid('logo_media_id')->nullable();
            $table->ulid('favicon_media_id')->nullable();
            $table->string('contact_phone', 16)->nullable();
            $table->string('contact_email', 254)->nullable();
            $table->string('whatsapp', 16)->nullable();
            $table->string('support_hours', 80)->nullable();
            $table->jsonb('social_links')->default('{}');
            $table->jsonb('business_address')->nullable();
            $table->boolean('use_address_for_returns')->default(true);

            // FK(t): media must belong to the same tenant as the settings row.
            $table->foreign(['tenant_id', 'logo_media_id'])->references(['tenant_id', 'id'])->on('media')->restrictOnDelete();
            $table->foreign(['tenant_id', 'favicon_media_id'])->references(['tenant_id', 'id'])->on('media')->restrictOnDelete();
        });

        Schema::table('store_settings', function (Blueprint $table) {
            $table->dropColumn(['logo_url', 'favicon_url']);
        });
    }

    public function down(): void
    {
        Schema::table('store_settings', function (Blueprint $table) {
            $table->dropForeign(['tenant_id', 'logo_media_id']);
            $table->dropForeign(['tenant_id', 'favicon_media_id']);
        });

        Schema::table('store_settings', function (Blueprint $table) {
            $table->dropColumn([
                'logo_media_id', 'favicon_media_id', 'contact_phone', 'contact_email', 'whatsapp',
                'support_hours', 'social_links', 'business_address', 'use_address_for_returns',
            ]);
            $table->string('logo_url', 2048)->nullable();
            $table->string('favicon_url', 2048)->nullable();
        });
    }
};
