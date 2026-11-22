<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/** Phase 5 §2: stores.published_at (P5-25). Stores that are already live count as published when last updated. */
return new class extends Migration
{
    public function up(): void
    {
        Schema::table('stores', function (Blueprint $table) {
            $table->timestampTz('published_at')->nullable();
        });

        DB::table('stores')->where('status', 'active')->whereNull('published_at')->update(['published_at' => DB::raw('updated_at')]);
    }

    public function down(): void
    {
        Schema::table('stores', function (Blueprint $table) {
            $table->dropColumn('published_at');
        });
    }
};
