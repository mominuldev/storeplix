<?php

declare(strict_types=1);

namespace App\Domain\Integrations\Console;

use App\Domain\Integrations\IntegrationCredentials;
use App\Domain\Tenancy\Support\PlatformDb;
use Illuminate\Console\Command;
use Illuminate\Contracts\Encryption\DecryptException;
use Illuminate\Support\Facades\Schema;

/**
 * `integrations:rotate-key` (PHASE-5B §15): re-encrypts every integration secret with the current
 * INTEGRATION_CREDENTIALS_KEY (values readable only with a previous key are rewritten; current ones are skipped).
 * Platform code: runs across tenants on the platform connection (B11). Prints counts and ids only, never values.
 */
final class RotateIntegrationKey extends Command
{
    protected $signature = 'integrations:rotate-key {--dry-run : Count what would change without writing}';

    protected $description = 'Re-encrypt integration credentials with the current INTEGRATION_CREDENTIALS_KEY';

    /** table => encrypted columns (tables of later increments are skipped until they exist). */
    public const COLUMNS = [
        'payment_gateway_accounts' => ['credentials'],
        'courier_accounts' => ['credentials', 'webhook_secret_encrypted'],
        'store_integrations' => ['credentials'], // PHASE-8-9D P89D-5
    ];

    public function handle(IntegrationCredentials $credentials): int
    {
        $db = PlatformDb::connection();
        $dry = (bool) $this->option('dry-run');
        $failed = 0;

        foreach (self::COLUMNS as $table => $columns) {
            if (! Schema::connection($db->getName())->hasTable($table)) {
                continue;
            }
            foreach ($columns as $column) {
                if (! Schema::connection($db->getName())->hasColumn($table, $column)) {
                    continue;
                }
                $rotated = 0;
                $current = 0;
                $db->table($table)->select(['id', $column])->whereNotNull($column)->orderBy('id')
                    ->chunkById(200, function ($rows) use ($db, $table, $column, $credentials, $dry, &$rotated, &$current, &$failed) {
                        foreach ($rows as $row) {
                            $value = (string) $row->{$column};
                            if ($credentials->isCurrent($value)) {
                                $current++;

                                continue;
                            }
                            try {
                                $fresh = $credentials->reencrypt($value);
                            } catch (DecryptException) {
                                $failed++;
                                $this->error("{$table}.{$column} {$row->id}: not decryptable with any configured key");

                                continue;
                            }
                            if (! $dry) {
                                $db->table($table)->where('id', $row->id)->update([$column => $fresh]);
                            }
                            $rotated++;
                        }
                    });
                $this->info(($dry ? '[dry run] ' : '')."{$table}.{$column}: {$rotated} re-encrypted, {$current} already current");
            }
        }

        return $failed === 0 ? self::SUCCESS : self::FAILURE;
    }
}
