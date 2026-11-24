<?php

namespace App\Providers;

use App\Domain\Automations\AutomationsServiceProvider;
use App\Domain\Developer\External\ExternalGate;
use App\Domain\Developer\External\Http\Middleware\AuthenticateApiKey;
use App\Domain\Expenses\ExpensesServiceProvider;
use App\Domain\Stores\Services\StorefrontContext;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Foundation\DevCommands;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;
use Laravel\Sanctum\Sanctum;

class AppServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        // Phase 8.6: automations (commands + limiters) live in their domain provider.
        $this->app->register(AutomationsServiceProvider::class);
        // Phase 8.7: expenses (commands + limiters).
        $this->app->register(ExpensesServiceProvider::class);
    }

    public function boot(): void
    {
        $this->registerDevProcesses();

        // Phase 4.7c: no Bearer / personal-access-token authentication. Merchant and admin SPAs use same-origin cookie
        // sessions; Phase 8 API keys will be a separate mechanism. A Bearer header is simply ignored → 401.
        Sanctum::getAccessTokenFromRequestUsing(fn () => null);

        // QA M-3: per-identifier limits for credential attempts + a looser per-IP ceiling
        // (many Bangladeshi mobile users share one carrier-NAT IP). Every 429 carries retry_after.
        $ip = fn (Request $r) => (string) $r->ip();
        $email = fn (Request $r) => strtolower(trim((string) $r->input('email')));

        RateLimiter::for('login', fn (Request $r) => [
            Limit::perMinute(5)->by('login:'.$email($r).'|'.$ip($r)),
            Limit::perMinute(60)->by('login-ip:'.$ip($r)),
        ]);

        RateLimiter::for('register', fn (Request $r) => Limit::perMinute(10)->by('register-ip:'.$ip($r)));

        RateLimiter::for('password-reset', fn (Request $r) => [
            Limit::perMinute(5)->by('pw-reset:'.($email($r) ?: strtolower(trim((string) $r->input('phone'))))),
            Limit::perMinute(30)->by('pw-reset-ip:'.$ip($r)),
        ]);

        RateLimiter::for('invitation', fn (Request $r) => [
            Limit::perMinute(10)->by('invitation:'.hash('sha256', (string) $r->route('token'))),
            Limit::perMinute(60)->by('invitation-ip:'.$ip($r)),
        ]);

        // Coarse per-IP guard for OTP endpoints (verify attempts are also capped per code).
        RateLimiter::for('otp', fn (Request $request) => Limit::perMinute(30)->by('otp-ip:'.$request->ip()));

        // 1 resend per minute per invitation.
        RateLimiter::for('invitation-resend', function (Request $request) {
            $invitation = $request->route('invitation');

            return Limit::perMinute(1)->by('invitation-resend:'.(is_object($invitation) ? $invitation->getKey() : (string) $invitation));
        });

        // Phase 4: default merchant limiter (per user + tenant) and the bulk-data limiter (imports/exports, per tenant).
        RateLimiter::for('merchant', fn (Request $r) => Limit::perMinute(300)
            ->by('merchant:'.($r->user()?->getAuthIdentifier() ?? $ip($r)).'|'.strtolower((string) $r->header('X-Tenant-Id'))));
        // Phase 8.4 (PHASE-8-4 §3, S111): 120 requests / minute per API key (the `apikey` middleware runs first).
        RateLimiter::for('external-api', fn (Request $r) => Limit::perMinute(120)
            ->by('external-api:'.($r->attributes->get(AuthenticateApiKey::ATTRIBUTE)?->getKey() ?? 'ip:'.$ip($r))));
        // P84-4: merchant policies evaluated for API-key requests (no user) with the key's tenant context.
        ExternalGate::register(Gate::getFacadeRoot());
        RateLimiter::for('merchant-bulk', fn (Request $r) => Limit::perHour((int) config('storeplix.bulk_per_hour', 10))
            ->by('merchant-bulk:'.strtolower((string) $r->header('X-Tenant-Id'))));

        // Storefront traffic is proxied by the Next.js server (P5B-9, PHASE-5B-CONTRACT §2.10): per store host + the
        // shopper IP the server forwards (trusted only with a valid key; IPv6 by /64) AND per store host. Without a
        // trusted IP (ISR revalidation, server-only fetches) only the host limit applies.
        // QA 5b-1 F-M1: a request without a valid storefront key never touches the host bucket (anyone could drain a
        // shop's 3 000/min by skipping the storefront); it is counted per request IP under its own key, and
        // ResolveStorefront then answers 401.
        RateLimiter::for('storefront', function (Request $request) {
            $host = strtolower(trim((string) $request->header('X-Storefront-Host')));
            if (! StorefrontContext::hasValidKey($request)) {
                return [Limit::perMinute((int) config('storeplix.storefront_per_ip_per_minute', 300))
                    ->by('sf-keyless:'.StorefrontContext::ipKey((string) $request->ip()))];
            }
            $limits = [];
            $client = StorefrontContext::trustedClientIp($request);
            if ($client !== null) {
                $limits[] = Limit::perMinute((int) config('storeplix.storefront_per_ip_per_minute', 300))
                    ->by('sf-ip:'.$host.'|'.StorefrontContext::ipKey($client));
            } elseif (Cache::add('sf-ip-missing-warned:'.$host, true, now()->addMinutes(5))) {
                // QA 5b-1 F-L5: once per host per 5 minutes; check the storefront's TRUSTED_PROXY / IP forwarding.
                Log::warning('storefront.client_ip_missing', ['host' => $host]);
            }
            $limits[] = Limit::perMinute((int) config('storeplix.storefront_per_host_per_minute', 3000))->by('sf:'.$host);

            return $limits;
        });
    }

    /**
     * `composer dev` / `php artisan dev`: the local stack mirrors docker compose (QA F-L3). The framework default is one
     * `serve` process plus a single `queue:listen` on `default`, so `bulk` imports never ran and one slow request
     * stalled every page. Here: a multi-worker server (PHP_CLI_SERVER_WORKERS needs --no-reload), short jobs and
     * `bulk` on separate workers so imports never wait behind revalidation, and the scheduler.
     */
    private function registerDevProcesses(): void
    {
        if (! $this->app->runningInConsole() || ! class_exists(DevCommands::class)) {
            return;
        }

        DevCommands::withoutDefaultCommands();
        DevCommands::artisan('serve --port=8010 --no-reload', 'server');
        DevCommands::artisan('queue:listen --queue=default,media --tries=3 --timeout=90', 'queue');
        DevCommands::artisan('queue:listen --queue=bulk --tries=1 --timeout=310 --memory=512', 'queue-bulk');
        // Phase 5a (QA 5a F-M1): order SMS + email, mirrors compose `queue-notifications`.
        DevCommands::artisan('queue:listen --queue=notifications --tries=3 --backoff=10,60 --timeout=60', 'queue-notifications');
        // Phase 5b-4: PDF rendering (mirrors compose `queue-documents`, PHASE-5B §17).
        DevCommands::artisan('queue:listen --queue=documents --tries=2 --timeout=150', 'queue-documents');
        // Phase 6: custom domain checks (mirrors compose `queue-domains`, PHASE-6 §11).
        DevCommands::artisan('queue:listen --queue=domains --tries=3 --timeout=90', 'queue-domains');
        // Phase 7: platform billing (mirrors compose `queue-billing`, PHASE-7 §4.5).
        DevCommands::artisan('queue:listen --queue=billing --tries=3 --timeout=150', 'queue-billing');
        // Phase 8.4: outbound merchant webhooks (mirrors compose `queue-webhooks-out`, PHASE-8-4 §4.3).
        DevCommands::artisan('queue:listen --queue=webhooks-out --tries=1 --timeout=40', 'queue-webhooks-out');
        // Phase 8.5: marketing campaigns (PHASE-8-5 §5.1, P85-12; tries=1: never resend a campaign message).
        DevCommands::artisan('queue:listen --queue=campaigns --tries=1 --timeout=250', 'queue-campaigns');
        // Phase 8.6: automations (PHASE-8-6 P86-23; tries=1: never repeat an automation message).
        DevCommands::artisan('queue:listen --queue=automations --tries=1 --timeout=250', 'queue-automations');
        DevCommands::artisan('schedule:work', 'scheduler');
    }
}
