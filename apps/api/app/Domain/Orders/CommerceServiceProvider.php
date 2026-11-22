<?php

namespace App\Domain\Orders;

use App\Domain\Cart\Console\PruneCarts;
use App\Domain\Geo\BdGeo;
use App\Domain\Orders\Console\ExpireConfirmationTokens;
use App\Domain\Payments\Console\ExpirePaymentLinks;
use App\Domain\Payments\Console\ExpirePayments;
use App\Domain\Payments\Console\ReconcilePayments;
use App\Domain\Payments\Console\SyncRefundStatus;
use App\Domain\Shared\Console\PruneIdempotencyKeys;
use App\Domain\Shared\Idempotency\IdempotencyGuard;
use App\Domain\Shared\Support\Phone;
use App\Domain\Shipping\Console\ProvisionShippingDefaults;
use App\Domain\Stores\Services\StorefrontContext;
use App\Domain\Webhooks\Console\PruneWebhookEvents;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Http\Request;
use Illuminate\Routing\Router;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;

/** Phase 5a commerce: geo, shipping, coupons, cart, checkout, orders (commands, middleware alias, rate limiters). */
class CommerceServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(BdGeo::class);
    }

    public function boot(Router $router): void
    {
        if ($this->app->runningInConsole()) {
            $this->commands([ProvisionShippingDefaults::class, PruneCarts::class, PruneIdempotencyKeys::class, ExpireConfirmationTokens::class,
                // 5b-2 payments (PHASE-5B §3 schedules)
                ExpirePayments::class, ReconcilePayments::class, SyncRefundStatus::class, ExpirePaymentLinks::class, PruneWebhookEvents::class]);
        }

        $router->aliasMiddleware('idempotent', IdempotencyGuard::class);

        // Storefront traffic arrives from the Next.js server: limit per store host + the shopper IP the server forwards
        // (X-Storefront-Client-Ip, trusted only with a valid storefront key).
        $host = fn (Request $r) => strtolower((string) $r->header('X-Storefront-Host'));
        $ip = fn (Request $r) => StorefrontContext::clientIp($r);

        RateLimiter::for('cart', fn (Request $r) => Limit::perMinute(60)->by('cart:'.$host($r).'|'.$ip($r)));

        RateLimiter::for('checkout', function (Request $r) use ($host, $ip) {
            $limits = [Limit::perMinute(10)->by('checkout:'.$host($r).'|'.$ip($r))];
            $phone = Phone::bdMsisdn(is_string($r->input('contact.phone')) ? $r->input('contact.phone') : null);
            if ($phone !== null) {
                $limits[] = Limit::perMinutes(10, 5)->by('checkout-phone:'.$host($r).'|'.$phone);
            }

            return $limits;
        });

        RateLimiter::for('order-track', fn (Request $r) => Limit::perMinute(10)->by('order-track:'.$host($r).'|'.$ip($r)));

        // 5b-2 (P5B-23, S28): payment-link pages, 20/min per store host + shopper IP.
        RateLimiter::for('pay-link', fn (Request $r) => Limit::perMinute(20)->by('pay-link:'.$host($r).'|'.StorefrontContext::ipKey($ip($r))));
        // 5b-2/5b-3 provider webhooks: per route key and per sender IP.
        RateLimiter::for('webhooks', fn (Request $r) => [
            Limit::perMinute(600)->by('webhooks-key:'.(string) $r->route('routeKey')),
            Limit::perMinute(300)->by('webhooks-ip:'.$r->ip()),
        ]);
        // Gateway browser returns (signed URLs) per IP.
        RateLimiter::for('payment-returns', fn (Request $r) => Limit::perMinute(60)->by('payment-returns:'.$r->ip()));

        RateLimiter::for('geo', fn (Request $r) => Limit::perMinute(60)->by('geo:'.$r->ip()));
    }
}
