<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    /** Old free-text labels → BUSINESS_CATEGORIES codes. Unknown labels are dropped. */
    private const MAP = [
        'fashion' => 'fashion',
        'beauty' => 'beauty',
        'kids' => 'kids',
        'food & grocery' => 'food_grocery',
        'food_grocery' => 'food_grocery',
        'food and grocery' => 'food_grocery',
        'grocery' => 'food_grocery',
        'electronics' => 'electronics',
        'home' => 'home',
    ];

    public function up(): void
    {
        Schema::table('stores', function (Blueprint $table) {
            $table->string('name_bn', 80)->nullable();
            $table->jsonb('business_categories')->default('[]');
            $table->string('timezone', 64)->default('Asia/Dhaka');
        });

        DB::table('stores')->whereNotNull('business_category')->orderBy('id')
            ->each(function (object $row): void {
                $codes = collect(explode(',', (string) $row->business_category))
                    ->map(fn (string $label) => self::MAP[strtolower(trim($label))] ?? null)
                    ->filter()->unique()->values()->all();

                DB::table('stores')->where('id', $row->id)->update(['business_categories' => json_encode($codes)]);
            });

        Schema::table('stores', function (Blueprint $table) {
            $table->dropColumn('business_category');
        });
    }

    public function down(): void
    {
        Schema::table('stores', function (Blueprint $table) {
            $table->string('business_category', 100)->nullable();
        });

        Schema::table('stores', function (Blueprint $table) {
            $table->dropColumn(['name_bn', 'business_categories', 'timezone']);
        });
    }
};
