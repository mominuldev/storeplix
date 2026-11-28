<?php

declare(strict_types=1);

namespace App\Domain\Sms\Providers;

use App\Domain\Integrations\IntegrationCredentials;
use App\Domain\Shared\Support\Money;
use App\Domain\Sms\Mail\PlatformSmsMail;
use App\Domain\Sms\Models\SmsProvider;
use App\Domain\Sms\Routing\SmsDriverFactory;
use App\Domain\Sms\Routing\SmsRoutingTable;
use App\Domain\Sms\SmsSendFailed;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\Support\PlatformDb;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * PHASE-8-9B §4.7 (P89B-23): reads a provider's gateway balance (drivers that support it; `http` → `unsupported`),
 * stores it on the row and runs the low-balance alert: one email to every active super admin (when `alert_email`) and
 * the audit row once per crossing below `low_threshold_paisa` (`low_balance_alerted_at`), re-armed when back above.
 * Two failed fetches in a row raise the `balance_unavailable` alert.
 */
final class SmsBalanceService
{
    public function __construct(
        private readonly SmsDriverFactory $factory,
        private readonly IntegrationCredentials $crypto,
        private readonly AuditLogger $audit,
    ) {}

    public function refresh(SmsProvider $provider, ?SmsConnection $connection = null): ?SmsProvider
    {
        if ($provider->role === SmsProvider::REMOVED || $provider->credentials_encrypted === null) {
            return null;
        }
        $update = ['balance_fetched_at' => now(), 'updated_at' => now()];
        try {
            $connection ??= SmsDriverFactory::connect($this->crypto->decrypt($provider->credentials_encrypted), (array) $provider->settings,
                (int) $provider->failover_timeout_seconds, $provider->id);
            $balance = $this->factory->driver($provider->driver)->balance($connection);
            $update += $balance === null
                ? ['balance_status' => 'unsupported', 'balance_amount' => null, 'balance_failures' => 0]
                : ['balance_status' => 'ok', 'balance_amount' => $balance->amountPaisa, 'balance_failures' => 0];
        } catch (SmsSendFailed $e) {
            $update += ['balance_status' => 'error', 'balance_failures' => $provider->balance_failures + 1];
            Log::warning('platform_sms.balance_failed', ['provider_id' => $provider->id, 'error_code' => $e->errorCode()]);
        } catch (Throwable $e) {
            $update += ['balance_status' => 'error', 'balance_failures' => $provider->balance_failures + 1];
            Log::warning('platform_sms.balance_failed', ['provider_id' => $provider->id, 'error' => $e::class]);
        }
        PlatformDb::reroute(SmsProvider::query())->whereKey($provider->id)->update($update);
        $fresh = PlatformDb::reroute(SmsProvider::query())->whereKey($provider->id)->first();
        if ($fresh !== null) {
            $this->alerts($fresh);
        }
        SmsRoutingTable::flush();

        return $fresh;
    }

    /** Low-balance crossing (once) and re-arm. */
    public function alerts(SmsProvider $p): void
    {
        if ($p->balance_status !== 'ok' || $p->balance_amount === null || $p->low_threshold_paisa === null) {
            return;
        }
        $query = PlatformDb::reroute(SmsProvider::query())->whereKey($p->id);
        if ($p->balance_amount >= $p->low_threshold_paisa) {
            if ($p->low_balance_alerted_at !== null) {
                $query->update(['low_balance_alerted_at' => null]); // re-armed
            }

            return;
        }
        // Claim the crossing atomically: only one fetch alerts.
        if ($query->whereNull('low_balance_alerted_at')->update(['low_balance_alerted_at' => now()]) !== 1) {
            return;
        }
        $meta = ['balance_paisa' => $p->balance_amount, 'threshold_paisa' => $p->low_threshold_paisa, 'provider' => $p->name];
        $this->audit->log('sms_provider.low_balance', $p, $meta, tenantId: false, system: true);
        if ($p->alert_email) {
            try {
                PlatformSmsMail::toSuperAdmins(PlatformSmsMail::LOW_BALANCE, [
                    'provider' => $p->name, 'balance' => Money::bdt($p->balance_amount), 'threshold' => Money::bdt($p->low_threshold_paisa),
                ]);
            } catch (Throwable $e) {
                Log::warning('platform_sms.low_balance_mail_failed', ['provider_id' => $p->id, 'error' => $e::class]);
            }
        }
    }
}
