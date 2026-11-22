<?php

declare(strict_types=1);

namespace Tests\Support;

use App\Domain\Orders\Models\Payment;
use App\Domain\Payments\Models\PaymentGatewayAccount;
use App\Domain\Stores\Models\Store;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Factory;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;

/** 5b-2 driver tests: accounts/payments rows and an Http::fake router fed by tests/Fixtures/payments (docs-built). */
trait PaymentGatewayFixtures
{
    /** @var list<string> paths called, in order */
    protected array $calls = [];

    protected function gatewayAccount(Store $store, string $provider, array $credentials): PaymentGatewayAccount
    {
        $a = new PaymentGatewayAccount;
        $a->store_id = $store->id;
        $a->provider = $provider;
        $a->mode = 'sandbox';
        $a->status = 'connected';
        $a->credentials = $credentials;
        $a->route_key = PaymentGatewayAccount::newRouteKey();
        $a->save();

        return $a;
    }

    protected function gatewayPayment(Store $store, PaymentGatewayAccount $account, int $amount, array $extra = []): Payment
    {
        $p = new Payment;
        $p->store_id = $store->id;
        $p->provider = $account->provider;
        $p->type = 'charge';
        $p->status = 'pending';
        $p->purpose = 'test';
        $p->amount = $amount;
        $p->currency = 'BDT';
        $p->gateway_account_id = $account->id;
        foreach ($extra as $k => $v) {
            $p->{$k} = $v;
        }
        $p->save();

        return $p;
    }

    /**
     * Routes requests by the path after the provider base URL. A route is a fixture name, a list (sequence: one entry
     * per call, the last repeats), 'timeout', or a callable(Request): response.
     *
     * @param  array<string, mixed>  $routes  path suffix => route
     * @param  array<string, string>  $vars  placeholder => value for fixtures ("{amount}" => "10.00")
     */
    protected function fakeProvider(array $routes, array $vars = []): void
    {
        $this->calls = [];
        $counters = [];
        Http::swap(new Factory(app('events'))); // a fresh fake per call: stubs don't stack
        Http::fake(function (Request $request) use ($routes, $vars, &$counters) {
            $path = (string) parse_url($request->url(), PHP_URL_PATH);
            foreach ($routes as $suffix => $route) {
                if (! str_ends_with($path, $suffix)) {
                    continue;
                }
                $this->calls[] = $suffix;
                if (is_array($route)) {
                    $i = $counters[$suffix] = ($counters[$suffix] ?? -1) + 1;
                    $route = $route[min($i, count($route) - 1)];
                }
                if (is_callable($route)) {
                    return $route($request);
                }
                if ($route === 'timeout') {
                    throw new ConnectionException('cURL error 28: Operation timed out');
                }
                if (is_int($route)) {
                    return Http::response('', $route);
                }

                return Http::response($this->paymentFixture((string) $route, $vars));
            }

            return Http::response(['unexpected' => $path], 599);
        });
    }

    /** @return array<string, mixed> */
    protected function paymentFixture(string $name, array $vars = []): array
    {
        $json = (string) file_get_contents(base_path("tests/Fixtures/payments/{$name}.json"));
        foreach ($vars as $k => $v) {
            $json = str_replace('{'.$k.'}', $v, $json);
        }

        return json_decode($json, true, 512, JSON_THROW_ON_ERROR);
    }

    protected function callCount(string $suffix): int
    {
        return count(array_filter($this->calls, fn ($c) => $c === $suffix));
    }
}
