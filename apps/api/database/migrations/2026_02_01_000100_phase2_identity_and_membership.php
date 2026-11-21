<?php

use App\Domain\Shared\Support\Phone;
use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::table('users', function (Blueprint $table) {
            $table->timestamp('password_changed_at')->nullable();
            $table->timestamp('phone_verified_at')->nullable(); // Addendum A
        });

        // Addendum A: account phones are BD mobiles stored as 8801XXXXXXXXX and unique.
        // Normalise existing values; anything else (or a duplicate) is cleared.
        $seen = [];
        DB::table('users')->whereNotNull('phone')->orderBy('created_at')->get(['id', 'phone'])
            ->each(function (object $row) use (&$seen): void {
                $msisdn = Phone::bdMsisdn($row->phone);
                if ($msisdn !== null && isset($seen[$msisdn])) {
                    $msisdn = null;
                }
                if ($msisdn !== null) {
                    $seen[$msisdn] = true;
                }
                DB::table('users')->where('id', $row->id)->update(['phone' => $msisdn]);
            });

        Schema::table('users', function (Blueprint $table) {
            $table->unique('phone');
        });

        Schema::table('tenant_users', function (Blueprint $table) {
            $table->foreignUlid('invited_by')->nullable()->constrained('users')->nullOnDelete();
            $table->timestamp('joined_at')->nullable();
            $table->unique(['tenant_id', 'id']);
        });

        DB::table('tenant_users')->whereNull('joined_at')->update(['joined_at' => DB::raw('created_at')]);

        // Exactly one owner per tenant (partial unique index; valid on Postgres and SQLite).
        DB::statement("CREATE UNIQUE INDEX tenant_users_one_owner ON tenant_users (tenant_id) WHERE role = 'owner'");

        Schema::table('audit_logs', function (Blueprint $table) {
            $table->string('user_agent', 255)->nullable();
            $table->index(['tenant_id', 'action', 'created_at']);
            $table->index(['tenant_id', 'actor_id', 'created_at']);
        });
    }

    public function down(): void
    {
        Schema::table('audit_logs', function (Blueprint $table) {
            $table->dropIndex(['tenant_id', 'action', 'created_at']);
            $table->dropIndex(['tenant_id', 'actor_id', 'created_at']);
            $table->dropColumn('user_agent');
        });

        DB::statement('DROP INDEX tenant_users_one_owner');

        Schema::table('tenant_users', function (Blueprint $table) {
            $table->dropUnique(['tenant_id', 'id']);
            $table->dropConstrainedForeignId('invited_by');
            $table->dropColumn('joined_at');
        });

        Schema::table('users', function (Blueprint $table) {
            $table->dropUnique(['phone']);
            $table->dropColumn(['password_changed_at', 'phone_verified_at']);
        });
    }
};
