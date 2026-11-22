<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Schema;

/**
 * PHASE-6-CONTRACT §3.1: store_domains gains the custom-domain lifecycle columns, a data fix (one primary per store,
 * platform rows active, lowercase hostnames, tokens on custom rows) and its constraints. CHECKs are Postgres-only;
 * the indexes (partial ones included) exist on sqlite too. Forward-only once merged; down() exists for the CI
 * rollback-and-re-migrate check.
 */
return new class extends Migration
{
    private const STATUSES = ['pending_verification', 'verification_failed', 'verified', 'ssl_provisioning', 'active', 'expired', 'suspended'];

    private const CHECKS = [
        'store_domains_type_check' => "type IN ('platform','custom')",
        'store_domains_status_check' => null, // built from STATUSES
        'store_domains_platform_active_check' => "type = 'custom' OR status = 'active'",
        'store_domains_primary_active_check' => "NOT is_primary OR status = 'active'",
        'store_domains_token_check' => "type = 'platform' OR verification_token IS NOT NULL",
        'store_domains_hostname_check' => 'hostname = lower(hostname) AND length(hostname) <= 253',
        'store_domains_provider_check' => "provider IS NULL OR provider IN ('cloudflare','fake')",
    ];

    public function up(): void
    {
        Schema::table('store_domains', function (Blueprint $table) {
            $table->string('display_hostname', 253)->nullable();
            $table->timestampTz('verification_started_at')->nullable();
            $table->timestampTz('status_changed_at')->nullable();
            $table->timestampTz('activated_at')->nullable();
            $table->timestampTz('last_checked_at')->nullable();
            $table->timestampTz('next_check_at')->nullable();
            $table->timestampTz('first_failed_at')->nullable();
            $table->integer('check_attempts')->default(0);
            $table->string('failure_code', 48)->nullable();
            $table->string('failure_message', 255)->nullable();
            $table->jsonb('last_check')->nullable();
            $table->string('provider', 16)->nullable();
            $table->string('provider_hostname_id', 64)->nullable();
            $table->string('provider_status', 32)->nullable();
            $table->string('ssl_status', 32)->nullable();
            $table->foreignUlid('created_by')->nullable()->constrained('users')->nullOnDelete();
        });

        $pgsql = DB::getDriverName() === 'pgsql';
        if ($pgsql) {
            foreach (['verified_at', 'created_at', 'updated_at'] as $column) {
                $type = DB::selectOne(
                    'select data_type from information_schema.columns where table_schema = current_schema() and table_name = ? and column_name = ?',
                    ['store_domains', $column],
                )?->data_type;
                if ($type === 'timestamp without time zone') {
                    DB::statement("ALTER TABLE store_domains ALTER COLUMN {$column} TYPE timestamptz USING {$column} AT TIME ZONE 'UTC'");
                }
            }
        }

        $this->fixData();

        if ($pgsql) {
            foreach (self::CHECKS as $name => $sql) {
                $sql ??= "status IN ('".implode("','", self::STATUSES)."')";
                DB::statement("ALTER TABLE store_domains ADD CONSTRAINT {$name} CHECK ({$sql})");
            }
        }

        $true = $pgsql ? 'is_primary' : 'is_primary = 1';
        DB::statement("CREATE UNIQUE INDEX store_domains_one_primary ON store_domains (store_id) WHERE {$true}");
        DB::statement('CREATE UNIQUE INDEX store_domains_provider_hostname_id_unique ON store_domains (provider_hostname_id) WHERE provider_hostname_id IS NOT NULL');
        // Platform scheduler index (read only through the platform connection): deliberately not tenant-led.
        DB::statement('CREATE INDEX store_domains_next_check_at_index ON store_domains (next_check_at) WHERE next_check_at IS NOT NULL');

        Schema::table('store_domains', function (Blueprint $table) {
            $table->unique(['tenant_id', 'id']);
            $table->unique(['tenant_id', 'store_id', 'id']);
            $table->index(['tenant_id', 'store_id', 'type']);
        });
    }

    public function down(): void
    {
        $pgsql = DB::getDriverName() === 'pgsql';
        Schema::table('store_domains', function (Blueprint $table) {
            $table->dropIndex(['tenant_id', 'store_id', 'type']);
            $table->dropUnique(['tenant_id', 'store_id', 'id']);
            $table->dropUnique(['tenant_id', 'id']);
        });
        foreach (['store_domains_one_primary', 'store_domains_provider_hostname_id_unique', 'store_domains_next_check_at_index'] as $index) {
            DB::statement("DROP INDEX IF EXISTS {$index}");
        }
        if ($pgsql) {
            foreach (array_keys(self::CHECKS) as $name) {
                DB::statement("ALTER TABLE store_domains DROP CONSTRAINT IF EXISTS {$name}");
            }
        }
        Schema::table('store_domains', function (Blueprint $table) {
            $table->dropConstrainedForeignId('created_by');
            $table->dropColumn([
                'display_hostname', 'verification_started_at', 'status_changed_at', 'activated_at', 'last_checked_at',
                'next_check_at', 'first_failed_at', 'check_attempts', 'failure_code', 'failure_message', 'last_check',
                'provider', 'provider_hostname_id', 'provider_status', 'ssl_status',
            ]);
        });
        // verified_at / created_at / updated_at stay timestamptz (harmless; up() skips the conversion).
    }

    /** §3.1 data fix, before the constraints. Runs as the schema owner (RLS does not apply). */
    private function fixData(): void
    {
        DB::table('store_domains')->update(['hostname' => DB::raw('lower(hostname)')]);
        DB::table('store_domains')->where('type', 'platform')->update(['status' => 'active']);
        DB::table('store_domains')->update(['status_changed_at' => DB::raw('updated_at')]);
        DB::table('store_domains')->where('type', 'custom')->whereNull('verification_token')->pluck('id')
            ->each(fn (string $id) => DB::table('store_domains')->where('id', $id)->update(['verification_token' => self::token()]));
        // A primary must be active.
        DB::table('store_domains')->where('is_primary', true)->where('status', '<>', 'active')->update(['is_primary' => false]);

        $platformDomain = strtolower((string) config('storeplix.platform_domain'));
        foreach (DB::table('stores')->get(['id', 'slug']) as $store) {
            $rows = DB::table('store_domains')->where('store_id', $store->id)->orderBy('created_at')->get(['id', 'hostname', 'type', 'is_primary', 'status']);
            $primaries = $rows->filter(fn ($r) => (bool) $r->is_primary);
            if ($primaries->count() === 1) {
                continue;
            }
            $slugRow = $rows->first(fn ($r) => $r->hostname === strtolower($store->slug).'.'.$platformDomain)
                ?? $rows->first(fn ($r) => $r->type === 'platform');
            $keep = $slugRow ?? $rows->first(fn ($r) => $r->status === 'active');
            DB::table('store_domains')->where('store_id', $store->id)->update(['is_primary' => false]);
            if ($keep !== null) {
                DB::table('store_domains')->where('id', $keep->id)->update(['is_primary' => true]);
            }
        }
    }

    private static function token(): string
    {
        $alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
        $bits = '';
        foreach (str_split(random_bytes(32)) as $byte) {
            $bits .= str_pad(decbin(ord($byte)), 8, '0', STR_PAD_LEFT);
        }
        $out = '';
        foreach (str_split($bits, 5) as $chunk) {
            $out .= $alphabet[bindec(str_pad($chunk, 5, '0'))];
        }

        return $out;
    }
};
