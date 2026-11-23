<?php

declare(strict_types=1);

namespace App\Domain\Billing\Http\Controllers;

use App\Domain\Billing\Gateways\FakeBillingGateway;
use App\Domain\Billing\Models\BillingPayment;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Support\Money;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\URL;

/**
 * P7-20 fake hosted billing payment page (testing only, B25). Never registered in production; 404 unless
 * BILLING_FAKE=true. Signed, the tenant in the signature. Buttons: Pay, Pay wrong amount, Fail, Cancel, Pay then time out.
 */
final class FakeBillingGatewayController
{
    public function __construct(
        private readonly TenantContext $context,
        private readonly FakeBillingGateway $fake,
    ) {}

    public function show(Request $request, string $payment): Response
    {
        return $this->inTenant($request, $payment, function (BillingPayment $model) use ($request) {
            if ($this->fake->state($model->id) === null) {
                throw self::notFound();
            }
            $buttons = '';
            foreach (FakeBillingGateway::LABELS as $outcome => $label) {
                $action = URL::temporarySignedRoute('dev.fake-billing-gateway.outcome', now()->addHours(26), ['payment' => $model->id, 'outcome' => $outcome, 'tenant' => $request->query('tenant')], absolute: false);
                $buttons .= '<form method="post" action="'.e($action).'"><button type="submit" data-outcome="'.e($outcome).'">'.e($label).'</button></form>';
            }
            $html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
                .'<meta name="robots" content="noindex"><title>Fake billing gateway</title>'
                .'<style>body{font-family:system-ui,sans-serif;max-width:30rem;margin:3rem auto;padding:0 1rem}form{display:inline-block;margin:0 .5rem .5rem 0}button{font-size:1rem;padding:.6rem 1.2rem;cursor:pointer}</style></head><body>'
                .'<h1>Fake '.e($model->provider).' payment (Storeplix billing)</h1>'
                .'<p>Amount: <strong data-amount="'.$model->amount.'">'.e(Money::bdt($model->amount)).'</strong></p>'
                .'<p>Payment: <code>'.e($model->id).'</code></p><p>Local testing only (BILLING_FAKE). No money moves.</p>'
                .$buttons.'</body></html>';

            return new Response($html, 200, [
                'Content-Type' => 'text/html; charset=utf-8', 'Cache-Control' => 'no-store', 'X-Robots-Tag' => 'noindex',
                'Content-Security-Policy' => "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
            ]);
        });
    }

    public function outcome(Request $request, string $payment, string $outcome): RedirectResponse
    {
        return $this->inTenant($request, $payment, function (BillingPayment $model) use ($outcome) {
            $target = $this->fake->recordOutcome($model, $outcome) ?? throw self::notFound();

            return new RedirectResponse($target, 303, ['Cache-Control' => 'no-store']);
        });
    }

    /**
     * @template T
     *
     * @param  callable(BillingPayment): T  $callback
     * @return T
     */
    private function inTenant(Request $request, string $payment, callable $callback): mixed
    {
        $tenant = $request->query('tenant');
        if (! (bool) config('billing.fake') || app()->environment('production') || ! is_string($tenant) || $tenant === '') {
            throw self::notFound();
        }

        return $this->context->run($tenant, function () use ($payment, $callback) {
            $model = BillingPayment::query()->find(strtolower($payment)) ?? throw self::notFound();

            return $callback($model);
        });
    }

    private static function notFound(): ApiException
    {
        return new ApiException(404, 'not_found', 'Resource not found.');
    }
}
