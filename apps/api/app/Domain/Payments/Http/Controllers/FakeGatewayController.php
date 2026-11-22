<?php

declare(strict_types=1);

namespace App\Domain\Payments\Http\Controllers;

use App\Domain\Orders\Models\Payment;
use App\Domain\Payments\Gateways\FakeGateway;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Support\Money;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\RedirectResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Support\Facades\URL;

/**
 * P5B-29 fake hosted payment page (local / testing / e2e only). Never registered in production; answers 404 unless
 * PAYMENTS_FAKE=true. Both routes are signed and carry the tenant in the signature (like the document download), so
 * there is no pre-tenant lookup. Each button records the outcome in FakeGateway and 303-redirects the browser to the
 * return URL the payment was initiated with, plus the provider's return params.
 */
final class FakeGatewayController
{
    public function __construct(
        private readonly TenantContext $context,
        private readonly FakeGateway $fake,
    ) {}

    public function show(Request $request, string $payment): Response
    {
        return $this->inTenant($request, $payment, function (Payment $model) use ($request) {
            if ($this->fake->state($model) === null) {
                throw self::notFound();
            }
            $buttons = '';
            foreach (['pay' => 'Pay', 'fail' => 'Fail', 'cancel' => 'Cancel'] as $outcome => $label) {
                $action = URL::temporarySignedRoute('dev.fake-gateway.outcome', now()->addHours(26), ['payment' => $model->id, 'outcome' => $outcome, 'tenant' => $request->query('tenant')]);
                $buttons .= '<form method="post" action="'.e($action).'"><button type="submit" name="outcome" value="'.e($outcome).'" data-outcome="'.e($outcome).'">'.e($label).'</button></form>';
            }
            $html = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
                .'<meta name="robots" content="noindex"><title>Fake gateway</title>'
                .'<style>body{font-family:system-ui,sans-serif;max-width:28rem;margin:3rem auto;padding:0 1rem}form{display:inline-block;margin:0 .5rem .5rem 0}button{font-size:1rem;padding:.6rem 1.2rem;cursor:pointer}</style></head><body>'
                .'<h1>Fake '.e($model->provider).' payment</h1>'
                .'<p>Amount: <strong data-amount="'.$model->amount.'">'.e(Money::bdt($model->amount)).'</strong></p>'
                .'<p>Payment: <code>'.e($model->id).'</code> ('.e($model->purpose).')</p>'
                .'<p>Local testing only (PAYMENTS_FAKE). No money moves.</p>'
                .$buttons.'</body></html>';

            return new Response($html, 200, [
                'Content-Type' => 'text/html; charset=utf-8',
                'Cache-Control' => 'no-store',
                'X-Robots-Tag' => 'noindex',
                'Content-Security-Policy' => "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
            ]);
        });
    }

    public function outcome(Request $request, string $payment, string $outcome): RedirectResponse
    {
        return $this->inTenant($request, $payment, function (Payment $model) use ($outcome) {
            $target = $this->fake->recordOutcome($model, $outcome) ?? throw self::notFound();

            return new RedirectResponse($target, 303, ['Cache-Control' => 'no-store']);
        });
    }

    /**
     * @template T
     *
     * @param  callable(Payment): T  $callback
     * @return T
     */
    private function inTenant(Request $request, string $payment, callable $callback): mixed
    {
        $tenant = $request->query('tenant');
        if (! (bool) config('payments.fake') || app()->environment('production') || ! is_string($tenant) || $tenant === '') {
            throw self::notFound();
        }

        return $this->context->run($tenant, function () use ($payment, $callback) {
            $model = Payment::query()->whereKey(strtolower($payment))->first() ?? throw self::notFound();

            return $callback($model);
        });
    }

    private static function notFound(): ApiException
    {
        return new ApiException(404, 'not_found', 'Resource not found.');
    }
}
