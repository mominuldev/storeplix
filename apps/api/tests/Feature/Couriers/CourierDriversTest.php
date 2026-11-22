<?php

declare(strict_types=1);

namespace Tests\Feature\Couriers;

use App\Domain\Couriers\CourierManager;
use App\Domain\Couriers\Drivers\BookingRequest;
use App\Domain\Couriers\Drivers\BookingResult;
use App\Domain\Couriers\Drivers\CourierDriver;
use App\Domain\Couriers\Drivers\CourierException;
use App\Domain\Couriers\Drivers\FakeCourier;
use App\Domain\Couriers\Drivers\NormalisedStatus;
use App\Domain\Couriers\Drivers\PathaoCourier;
use App\Domain\Couriers\Drivers\RedxCourier;
use App\Domain\Couriers\Drivers\SteadfastCourier;
use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use App\Domain\Tenancy\Support\TenantCache;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Request;
use Illuminate\Log\Events\MessageLogged;
use Illuminate\Support\Facades\Event;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CommerceFixtures;
use Tests\TestCase;

/**
 * PHASE-5B §13 "Couriers (per driver with fixtures)": booking happy path, courier rejection, timeout → findByInvoice,
 * the data-driven status map over every raw status, webhook parsing/auth, cancel unsupported, Steadfast bulk chunks,
 * Pathao token caching. No real courier is ever called (Http::fake with preventStrayRequests).
 */
#[Group('couriers')]
class CourierDriversTest extends TestCase
{
    use CommerceFixtures, RefreshDatabase;

    private const CREDENTIALS = [
        'steadfast' => ['api_key' => 'sf-api-key-77aa', 'secret_key' => 'sf-secret-key-value'],
        'pathao' => ['client_id' => 'pathao-client-1d2e', 'client_secret' => 'pathao-client-secret', 'username' => 'merchant@example.test', 'password' => 'Pathao-Pass-1'],
        'redx' => ['access_token' => 'redx-access-token-9b2c'],
    ];

    private Tenant $tenant;

    private Store $store;

    protected function setUp(): void
    {
        parent::setUp();
        config(['couriers.fake' => false]);
        Http::preventStrayRequests();
        [, $this->tenant, $this->store] = $this->liveShop();
    }

    // ---------------------------------------------------------------- helpers

    private function account(string $provider, ?string $secret = 'whsec-0123456789012345678901234567890123'): CourierAccount
    {
        $a = new CourierAccount;
        $a->id = strtolower((string) Str::ulid());
        $a->tenant_id = $this->tenant->id;
        $a->store_id = $this->store->id;
        $a->provider = $provider;
        $a->mode = 'sandbox';
        $a->status = 'connected';
        $a->credentials = self::CREDENTIALS[$provider];
        $a->setWebhookSecret($secret);

        return $a;
    }

    private function request(array $override = []): BookingRequest
    {
        return new BookingRequest(...$override + [
            'invoice' => '01jdxk0000000000000000ship',
            'recipientName' => 'Rafi Ahmed',
            'recipientPhone' => '+8801711000001',
            'recipientAddress' => 'House 12, Road 7A',
            'district' => 'Dhaka',
            'thana' => 'Dhanmondi',
            'codAmount' => 177000,
            'weightGrams' => 500,
            'itemDescription' => 'Cotton Panjabi x1',
            'note' => 'Call first',
            'orderNumber' => 'SP-1001',
            'cityId' => '1',
            'zoneId' => '298',
            'areaId' => '37',
            'areaName' => 'Dhanmondi',
            'providerStoreId' => '1234',
        ]);
    }

    private function shipment(?string $consignment = '1424107', ?string $providerStatus = null, string $status = Shipment::BOOKED): Shipment
    {
        $s = new Shipment;
        $s->id = '01jdxk0000000000000000ship';
        $s->provider = 'steadfast';
        $s->status = $status;
        $s->consignment_id = $consignment;
        $s->provider_status = $providerStatus;
        $s->cod_amount = 177000;

        return $s;
    }

    private function driver(string $provider): CourierDriver
    {
        return app(CourierManager::class)->driver($provider);
    }

    private function fixture(string $name): array
    {
        return json_decode((string) file_get_contents(base_path("tests/Fixtures/couriers/{$name}.json")), true, 512, JSON_THROW_ON_ERROR);
    }

    private function assertCourierError(string $code, callable $fn): void
    {
        try {
            $fn();
            $this->fail("expected {$code}");
        } catch (CourierException $e) {
            $this->assertSame($code, $e->errorCode);
        }
    }

    private function within(callable $fn): mixed
    {
        return $this->inTenant($this->tenant, $fn);
    }

    // ---------------------------------------------------------------- manager

    public function test_manager_resolves_real_drivers_and_the_fake_when_configured(): void
    {
        $this->assertInstanceOf(SteadfastCourier::class, $this->driver('steadfast'));
        $this->assertInstanceOf(PathaoCourier::class, $this->driver('pathao'));
        $this->assertInstanceOf(RedxCourier::class, $this->driver('redx'));
        config(['couriers.fake' => true]);
        $this->assertInstanceOf(FakeCourier::class, $this->driver('pathao'));
        $this->assertSame('pathao', app(CourierManager::class)->fake('pathao')?->provider());
        $this->expectException(\InvalidArgumentException::class);
        $this->driver('sundarban');
    }

    // ---------------------------------------------------------------- status maps (§13 data-driven)

    /** @return iterable<string, array{0: class-string<CourierDriver>, 1: string, 2: ?string, 3: ?string, 4: bool}> */
    public static function statusRows(): iterable
    {
        $expected = [
            SteadfastCourier::class => [
                'in_review' => ['booked', null], 'pending' => ['booked', null], 'hold' => ['on_hold', 'on_hold'],
                'delivered_approval_pending' => ['delivered', null], 'delivered' => ['delivered', null],
                'partial_delivered_approval_pending' => ['partially_delivered', null], 'partial_delivered' => ['partially_delivered', null],
                'cancelled_approval_pending' => ['cancelled', null], 'cancelled' => ['cancelled', null],
                'unknown_approval_pending' => [null, 'unknown'], 'unknown' => [null, 'unknown'],
            ],
            PathaoCourier::class => [
                'created' => ['booked', null], 'pending' => ['booked', null], 'pickup-requested' => ['booked', null],
                'assigned-for-pickup' => ['booked', null], 'picked' => ['picked_up', null], 'pickup-failed' => [null, 'unknown'],
                'pickup-cancelled' => ['cancelled', null], 'at-the-sorting-hub' => ['in_transit', null], 'in-transit' => ['in_transit', null],
                'received-at-last-mile-hub' => ['in_transit', null], 'assigned-for-delivery' => ['out_for_delivery', null],
                'delivered' => ['delivered', null], 'partial-delivery' => ['partially_delivered', null],
                'delivery-failed' => ['delivery_failed', 'delivery_failed'], 'on-hold' => ['on_hold', 'on_hold'],
                'returned' => ['returning', 'returning'], 'return' => ['returning', 'returning'], 'return-id-created' => ['returning', 'returning'],
                'return-in-transit' => ['returning', 'returning'], 'returned-to-merchant' => ['returned', null],
                'paid' => [null, null, true], 'paid-return' => [null, null, true], 'payment-invoice' => [null, null, true],
                'exchanged' => [null, null], 'updated' => [null, null],
            ],
            RedxCourier::class => [
                'pickup-pending' => ['booked', null], 'ready-for-delivery' => ['in_transit', null], 'agent-area-change' => ['in_transit', null],
                'delivery-in-progress' => ['out_for_delivery', null], 'delivered' => ['delivered', null], 'agent-hold' => ['on_hold', 'on_hold'],
                'agent-returning' => ['returning', 'returning'], 'returned' => ['returned', null],
            ],
        ];
        foreach ($expected as $class => $rows) {
            foreach ($rows as $raw => $e) {
                yield class_basename($class).' '.$raw => [$class, $raw, $e[0], $e[1], $e[2] ?? false];
            }
        }
    }

    /** @param class-string<CourierDriver> $class */
    #[DataProvider('statusRows')]
    public function test_status_map_row(string $class, string $raw, ?string $status, ?string $problem, bool $settled): void
    {
        $n = app($class)->normalise($raw);
        $this->assertSame(['status' => $status, 'problem' => $problem, 'settled' => $settled], $n->toArray());
        if ($status !== null) {
            $this->assertContains($status, Shipment::COURIER_STATUSES);
        }
    }

    public function test_every_raw_status_of_every_map_is_covered_and_valid(): void
    {
        $covered = [];
        foreach (self::statusRows() as [$class, $raw]) {
            $covered[$class][] = $raw;
        }
        foreach ([SteadfastCourier::class, PathaoCourier::class, RedxCourier::class, FakeCourier::class] as $class) {
            foreach ($class::statusMap() as $raw => $n) {
                $this->assertInstanceOf(NormalisedStatus::class, $n);
                $this->assertTrue($n->status === null || in_array($n->status, Shipment::COURIER_STATUSES, true), "{$class} {$raw}");
                $this->assertTrue($n->problem === null || in_array($n->problem, Shipment::PROBLEMS, true), "{$class} {$raw}");
                if ($class !== FakeCourier::class) {
                    $this->assertContains($raw, $covered[$class], "{$class} raw status {$raw} lacks a test row");
                }
            }
        }
        // The documented raw lists are all mapped (fixtures from the public docs).
        foreach ($this->fixture('steadfast/statuses')['statuses'] as $raw) {
            $this->assertArrayHasKey($raw, SteadfastCourier::statusMap());
        }
        foreach ($this->fixture('pathao/events')['events'] as $event) {
            $this->assertArrayHasKey(PathaoCourier::key($event), PathaoCourier::statusMap(), $event);
        }
        foreach ($this->fixture('redx/statuses')['statuses'] as $raw) {
            $this->assertArrayHasKey($raw, RedxCourier::statusMap());
        }
        // Unknown words → problem unknown, status unchanged.
        $drivers = [app(SteadfastCourier::class), app(PathaoCourier::class), app(RedxCourier::class), new FakeCourier('steadfast', app(TenantCache::class))];
        foreach ($drivers as $driver) {
            $this->assertSame(['status' => null, 'problem' => 'unknown', 'settled' => false], $driver->normalise('lost_in_space')->toArray());
        }
    }

    public function test_steadfast_context_rules_pending_after_review_and_cancelled_after_pickup(): void
    {
        $d = app(SteadfastCourier::class);
        $this->assertSame('booked', $d->normalise('pending', $this->shipment(providerStatus: null))->status);
        $this->assertSame('in_transit', $d->normalise('pending', $this->shipment(providerStatus: 'in_review'))->status);
        $this->assertSame('in_transit', $d->normalise('pending', $this->shipment(providerStatus: 'pending', status: Shipment::IN_TRANSIT))->status);
        $this->assertSame('cancelled', $d->normalise('cancelled', $this->shipment(providerStatus: 'in_review'))->status);
        $returning = $d->normalise('cancelled_approval_pending', $this->shipment(providerStatus: 'pending', status: Shipment::IN_TRANSIT));
        $this->assertSame(['returning', 'returning'], [$returning->status, $returning->problem]);
    }

    // ---------------------------------------------------------------- Steadfast

    public function test_steadfast_credentials_booking_status_and_logs_without_secrets(): void
    {
        $logged = [];
        Event::listen(MessageLogged::class, function (MessageLogged $e) use (&$logged) {
            $logged[] = $e->message.' '.json_encode($e->context);
        });
        Http::fake([
            'portal.packzy.com/api/v1/get_balance' => Http::response($this->fixture('steadfast/get_balance')),
            'portal.packzy.com/api/v1/create_order' => Http::response($this->fixture('steadfast/create_order')),
            'portal.packzy.com/api/v1/status_by_cid/*' => Http::response($this->fixture('steadfast/status_by_cid')),
        ]);
        $a = $this->account('steadfast');
        $d = $this->driver('steadfast');

        $check = $this->within(fn () => $d->checkCredentials($a));
        $this->assertSame([true, 1234550], [$check->ok, $check->balanceAmount]);

        $r = $this->within(fn () => $d->book($this->shipment(null), $a, $this->request()));
        $this->assertSame(['1424107', '15BAEB8A', 'in_review'], [$r->consignmentId, $r->trackingCode, $r->providerStatus]);
        $this->assertSame('https://steadfast.com.bd/t/15BAEB8A', $r->trackingUrl);
        $this->assertSame('[redacted]', $r->raw['recipient_phone']);
        Http::assertSent(fn (Request $q) => $q->url() === 'https://portal.packzy.com/api/v1/create_order'
            && $q->hasHeader('Api-Key', 'sf-api-key-77aa') && $q->hasHeader('Secret-Key', 'sf-secret-key-value')
            && $q['invoice'] === '01jdxk0000000000000000ship' && $q['recipient_phone'] === '01711000001'
            && $q['cod_amount'] === 1770 && $q['recipient_address'] === 'House 12, Road 7A, Dhanmondi, Dhaka'
            && str_contains($q['note'], 'SP-1001'));

        $u = $this->within(fn () => $d->status($this->shipment('1424107', 'in_review'), $a));
        $this->assertSame(['delivered', 'delivered'], [$u->status, $u->providerStatus]);
        $this->assertTrue($u->isMoneyRelevant());

        $all = implode("\n", $logged);
        $this->assertStringContainsString('integration.http', $all);
        foreach ([...array_values(self::CREDENTIALS['steadfast']), 'Rafi', '01711000001'] as $secret) {
            $this->assertStringNotContainsString($secret, $all);
        }
    }

    public function test_steadfast_rejection_is_sanitised_and_maps_the_field(): void
    {
        Http::fake(['portal.packzy.com/*' => Http::response($this->fixture('steadfast/create_order_rejected'), 422)]);
        try {
            $this->within(fn () => $this->driver('steadfast')->book($this->shipment(null), $this->account('steadfast'), $this->request()));
            $this->fail('expected a rejection');
        } catch (CourierException $e) {
            $this->assertSame([CourierException::COURIER_REJECTED, 'recipient_phone', 422], [$e->errorCode, $e->field, $e->httpStatus()]);
            $this->assertStringNotContainsString('<script>', $e->getMessage());
            $this->assertStringStartsWith('The recipient phone must be 11 characters.', $e->getMessage());
        }
    }

    public function test_steadfast_timeout_is_provider_unavailable_then_find_by_invoice_reconciles(): void
    {
        Http::fake([
            'portal.packzy.com/api/v1/create_order' => fn () => throw new ConnectionException('timed out'),
            'portal.packzy.com/api/v1/trackings_by_invoice/*' => Http::sequence()
                ->push($this->fixture('steadfast/trackings_by_invoice'))->push(['message' => 'Not found'], 404),
        ]);
        $a = $this->account('steadfast');
        try {
            $this->within(fn () => $this->driver('steadfast')->book($this->shipment(null), $a, $this->request()));
            $this->fail('expected provider_unavailable');
        } catch (CourierException $e) {
            $this->assertSame([CourierException::PROVIDER_UNAVAILABLE, 502], [$e->errorCode, $e->httpStatus()]);
        }
        $found = $this->within(fn () => $this->driver('steadfast')->findByInvoice('01jdxk0000000000000000ship', $a));
        $this->assertInstanceOf(BookingResult::class, $found);
        $this->assertSame(['1424107', '15BAEB8A'], [$found->consignmentId, $found->trackingCode]);
        Http::assertSent(fn (Request $q) => $q->url() === 'https://portal.packzy.com/api/v1/trackings_by_invoice/01jdxk0000000000000000ship');

        $this->assertNull($this->within(fn () => $this->driver('steadfast')->findByInvoice('nope', $a)));
    }

    public function test_steadfast_bulk_sends_500_per_request_and_keys_results_like_the_input(): void
    {
        $calls = 0;
        Http::fake(['portal.packzy.com/api/v1/create_order/bulk-order' => function (Request $q) use (&$calls) {
            $calls++;
            $rows = array_map(fn (array $o) => ['invoice' => $o['invoice'], 'consignment_id' => crc32($o['invoice']), 'tracking_code' => 'T'.$o['invoice'],
                'status' => str_ends_with($o['invoice'], '-7') ? 'error' : 'success', 'error' => 'Bad phone'], json_decode($q['data'], true));

            return Http::response(['data' => $rows]);
        }]);
        $requests = [];
        for ($i = 0; $i < 501; $i++) {
            $requests["order-{$i}"] = $this->request(['invoice' => "inv-{$i}"]);
        }
        $out = $this->within(fn () => $this->driver('steadfast')->bookBulk($this->account('steadfast'), $requests));
        $this->assertSame(2, $calls);
        $this->assertSame(array_keys($requests), array_keys($out));
        $this->assertInstanceOf(BookingResult::class, $out['order-0']);
        $this->assertSame('Tinv-0', $out['order-0']->trackingCode);
        $this->assertInstanceOf(CourierException::class, $out['order-7']);
        $this->assertSame(CourierException::COURIER_REJECTED, $out['order-7']->errorCode);
        $this->assertInstanceOf(BookingResult::class, $out['order-500']);
    }

    public function test_steadfast_bulk_fixture_and_missing_rows_are_unknown_outcomes(): void
    {
        Http::fake(['portal.packzy.com/*' => Http::response($this->fixture('steadfast/bulk_order'))]);
        $out = $this->within(fn () => $this->driver('steadfast')->bookBulk($this->account('steadfast'), [
            'a' => $this->request(['invoice' => 'INV-A']), 'b' => $this->request(['invoice' => 'INV-B']), 'c' => $this->request(['invoice' => 'INV-C']),
        ]));
        $this->assertSame('1424200', $out['a']->consignmentId);
        $this->assertSame(CourierException::COURIER_REJECTED, $out['b']->errorCode);
        $this->assertSame(CourierException::PROVIDER_UNAVAILABLE, $out['c']->errorCode);
    }

    public function test_steadfast_webhook_needs_the_bearer_and_parses_the_package_payload(): void
    {
        $a = $this->account('steadfast');
        $payload = $this->fixture('steadfast/webhook_delivered');
        $d = $this->driver('steadfast');
        foreach ([[], ['Authorization' => 'Bearer wrong'], ['Authorization' => 'whsec-0123456789012345678901234567890123']] as $headers) {
            try {
                $d->parseWebhook($payload, $headers, $a);
                $this->fail('expected webhook_unauthorized');
            } catch (CourierException $e) {
                $this->assertSame([CourierException::WEBHOOK_UNAUTHORIZED, 401], [$e->errorCode, $e->httpStatus()]);
            }
        }
        $event = $d->parseWebhook($payload, ['authorization' => ['Bearer whsec-0123456789012345678901234567890123']], $a);
        $this->assertSame(['1424107', '01JDXK0000000000000000SHIP', 'delivery_status'], [$event->consignmentId, $event->invoice, $event->eventType]);
        $this->assertSame(['delivered', 'delivered', 177000], [$event->update->status, $event->update->providerStatus, $event->update->codCollectedAmount]);
        $this->assertSame('2026-11-23T06:45:30+00:00', $event->update->occurredAt->toIso8601String(), 'Dhaka local time → UTC');
        $this->assertSame(64, strlen($event->eventId));
        $this->assertSame($event->eventId, $d->parseWebhook($payload, ['Authorization' => 'Bearer whsec-0123456789012345678901234567890123'], $a)->eventId, 'stable dedupe key');
        $this->assertTrue($d->supportsWebhooks());
    }

    public function test_steadfast_and_redx_cancel_is_unsupported(): void
    {
        foreach (['steadfast', 'pathao', 'redx'] as $p) {
            try {
                $this->driver($p)->cancel($this->shipment(), $this->account($p));
                $this->fail("{$p} should not cancel");
            } catch (CourierException $e) {
                $this->assertSame([CourierException::CANCEL_UNSUPPORTED, 409], [$e->errorCode, $e->httpStatus()]);
            }
            $this->assertNotContains('cancel', $this->driver($p)->capabilities());
        }
        Http::assertNothingSent();
    }

    // ---------------------------------------------------------------- Pathao

    public function test_pathao_token_is_cached_per_account_and_booking_sends_the_documented_fields(): void
    {
        Http::fake([
            'courier-api-sandbox.pathao.com/aladdin/api/v1/issue-token' => Http::response($this->fixture('pathao/issue_token')),
            'courier-api-sandbox.pathao.com/aladdin/api/v1/orders' => Http::response($this->fixture('pathao/create_order')),
            'courier-api-sandbox.pathao.com/aladdin/api/v1/orders/*/info' => Http::response($this->fixture('pathao/order_info')),
        ]);
        $a = $this->account('pathao');
        $d = $this->driver('pathao');
        $this->assertTrue($this->within(fn () => $d->checkCredentials($a))->ok);
        $r = $this->within(fn () => $d->book($this->shipment(null), $a, $this->request()));
        $this->within(fn () => $d->book($this->shipment(null), $a, $this->request(['invoice' => 'second'])));
        $u = $this->within(fn () => $d->status($this->shipment('DL121224VS8TTJ'), $a));

        $this->assertSame(['DL121224VS8TTJ', 'DL121224VS8TTJ', 8000, 'pending'], [$r->consignmentId, $r->trackingCode, $r->deliveryFeeAmount, $r->providerStatus]);
        $this->assertSame(['delivered', 'delivered'], [$u->status, $u->providerStatus]);
        Http::assertSentCount(4 + 0); // issue (check) + 2 orders + info: the check's token is reused
        Http::assertSent(fn (Request $q) => str_ends_with($q->url(), '/issue-token') && $q['grant_type'] === 'password'
            && $q['client_id'] === 'pathao-client-1d2e' && $q['username'] === 'merchant@example.test');
        Http::assertSent(fn (Request $q) => str_ends_with($q->url(), '/aladdin/api/v1/orders') && $q->hasHeader('Authorization', 'Bearer pathao-access-token-sandbox')
            && $q['merchant_order_id'] === '01jdxk0000000000000000ship' && $q['store_id'] === 1234 && $q['recipient_city'] === 1
            && $q['recipient_zone'] === 298 && $q['recipient_area'] === 37 && $q['amount_to_collect'] === 1770 && $q['item_weight'] === '0.5'
            && $q['delivery_type'] === 48 && $q['item_type'] === 2 && $q['recipient_phone'] === '01711000001');
    }

    public function test_pathao_401_refreshes_the_token_once_and_bad_credentials_are_rejected(): void
    {
        $orders = 0;
        Http::fake([
            'courier-api-sandbox.pathao.com/aladdin/api/v1/issue-token' => Http::sequence()
                ->push($this->fixture('pathao/issue_token'))->push($this->fixture('pathao/issue_token'))
                ->push($this->fixture('pathao/issue_token_invalid'), 401),
            'courier-api-sandbox.pathao.com/aladdin/api/v1/orders' => function () use (&$orders) {
                return ++$orders === 1 ? Http::response(['message' => 'Unauthenticated.'], 401) : Http::response($this->fixture('pathao/create_order'));
            },
        ]);
        $a = $this->account('pathao');
        $this->within(fn () => $this->driver('pathao')->book($this->shipment(null), $a, $this->request()));
        $this->assertSame(2, $orders);

        $b = $this->account('pathao');
        $b->credentials = ['password' => 'wrong'] + self::CREDENTIALS['pathao'];
        try {
            $this->within(fn () => $this->driver('pathao')->checkCredentials($b));
            $this->fail('expected credentials_invalid');
        } catch (CourierException $e) {
            $this->assertSame(CourierException::CREDENTIALS_INVALID, $e->errorCode);
        }
    }

    public function test_pathao_rejections_weight_bounds_and_timeout_reconcile(): void
    {
        $a = $this->account('pathao');
        foreach ([['weightGrams' => 400], ['weightGrams' => 10001]] as $o) {
            try {
                $this->within(fn () => $this->driver('pathao')->book($this->shipment(null), $a, $this->request($o)));
                $this->fail('weight');
            } catch (CourierException $e) {
                $this->assertSame([CourierException::COURIER_REJECTED, 'weight_grams'], [$e->errorCode, $e->field]);
            }
        }
        Http::assertNothingSent();

        Http::fake([
            'courier-api-sandbox.pathao.com/aladdin/api/v1/issue-token' => Http::response($this->fixture('pathao/issue_token')),
            'courier-api-sandbox.pathao.com/aladdin/api/v1/orders' => Http::response($this->fixture('pathao/create_order_rejected'), 422),
        ]);
        try {
            $this->within(fn () => $this->driver('pathao')->book($this->shipment(null), $a, $this->request()));
            $this->fail('rejected');
        } catch (CourierException $e) {
            $this->assertSame([CourierException::COURIER_REJECTED, 'area', 'The selected recipient zone is invalid.'], [$e->errorCode, $e->field, $e->getMessage()]);
        }

        Http::fake([
            'courier-api-sandbox.pathao.com/aladdin/api/v1/issue-token' => Http::response($this->fixture('pathao/issue_token')),
            'courier-api-sandbox.pathao.com/aladdin/api/v1/orders?*' => Http::response($this->fixture('pathao/find_by_invoice')),
            'courier-api-sandbox.pathao.com/aladdin/api/v1/orders' => fn () => throw new ConnectionException('timeout'),
        ]);
        try {
            $this->within(fn () => $this->driver('pathao')->book($this->shipment(null), $a, $this->request()));
            $this->fail('timeout');
        } catch (CourierException $e) {
            $this->assertSame(CourierException::PROVIDER_UNAVAILABLE, $e->errorCode);
        }
        $found = $this->within(fn () => $this->driver('pathao')->findByInvoice('01JDXK0000000000000000SHIP', $a));
        $this->assertSame('DL121224VS8TTJ', $found?->consignmentId);
    }

    public function test_pathao_webhook_signature_integration_ack_and_event_id(): void
    {
        $a = $this->account('pathao');
        $d = $this->driver('pathao');
        $secret = 'whsec-0123456789012345678901234567890123';
        try {
            $d->parseWebhook($this->fixture('pathao/webhook_delivered'), ['X-PATHAO-Signature' => 'nope'], $a);
            $this->fail('expected webhook_unauthorized');
        } catch (CourierException $e) {
            $this->assertSame(CourierException::WEBHOOK_UNAUTHORIZED, $e->errorCode);
        }
        $this->assertNull($d->parseWebhook($this->fixture('pathao/webhook_integration'), ['x-pathao-signature' => $secret], $a));

        $p = $this->fixture('pathao/webhook_delivered');
        $event = $d->parseWebhook($p, ['X-PATHAO-Signature' => $secret], $a);
        $this->assertSame(hash('sha256', 'DL121224VS8TTJ|order.delivered|2026-11-23T09:20:00+00:00'), $event->eventId);
        $this->assertSame(['DL121224VS8TTJ', '01JDXK0000000000000000SHIP', 'order.delivered'], [$event->consignmentId, $event->invoice, $event->eventType]);
        $this->assertSame(['delivered', 'delivered'], [$event->update->status, $event->update->providerStatus]);

        $store = $d->parseWebhook(['event' => 'store.updated', 'store_id' => 1, 'timestamp' => 'x'], ['X-PATHAO-Signature' => $secret], $a);
        $this->assertNull($store->update);
        $this->assertArrayHasKey('X-Pathao-Merchant-Webhook-Integration-Secret', PathaoCourier::WEBHOOK_RESPONSE_HEADERS);
    }

    public function test_pathao_areas_and_pickup_stores(): void
    {
        Http::fake([
            'courier-api-sandbox.pathao.com/aladdin/api/v1/issue-token' => Http::response($this->fixture('pathao/issue_token')),
            'courier-api-sandbox.pathao.com/aladdin/api/v1/city-list' => Http::response($this->fixture('pathao/city_list')),
            'courier-api-sandbox.pathao.com/aladdin/api/v1/cities/1/zone-list' => Http::response($this->fixture('pathao/zone_list')),
            'courier-api-sandbox.pathao.com/aladdin/api/v1/zones/298/area-list' => Http::response($this->fixture('pathao/area_list')),
            'courier-api-sandbox.pathao.com/aladdin/api/v1/stores' => Http::response($this->fixture('pathao/stores')),
        ]);
        $a = $this->account('pathao');
        $d = $this->driver('pathao');
        $this->assertSame([['id' => '1', 'name' => 'Dhaka', 'level' => 'city', 'parent_id' => null], ['id' => '2', 'name' => 'Chittagong', 'level' => 'city', 'parent_id' => null]],
            array_map(fn ($x) => $x->toArray(), $this->within(fn () => $d->areas($a, 'city', null))));
        $this->assertSame('298', $this->within(fn () => $d->areas($a, 'zone', '1'))[0]->id);
        $this->assertSame(['id' => '37', 'name' => 'Dhanmondi 27', 'level' => 'area', 'parent_id' => '298'], $this->within(fn () => $d->areas($a, 'area', '298'))[0]->toArray());
        $this->assertSame([['id' => '1234', 'name' => 'Demo Shop', 'address' => 'House 1, Road 2, Dhanmondi']], array_map(fn ($s) => $s->toArray(), $this->within(fn () => $d->pickupStores($a))));
    }

    // ---------------------------------------------------------------- RedX

    public function test_redx_booking_status_areas_and_no_webhooks(): void
    {
        Http::fake([
            'sandbox.redx.com.bd/v1.0.0-beta/areas' => Http::response($this->fixture('redx/areas')),
            'sandbox.redx.com.bd/v1.0.0-beta/parcel' => Http::response($this->fixture('redx/create_parcel'), 201),
            'sandbox.redx.com.bd/v1.0.0-beta/parcel/info/*' => Http::response($this->fixture('redx/parcel_info')),
            'sandbox.redx.com.bd/v1.0.0-beta/pickup/stores' => Http::response($this->fixture('redx/pickup_stores')),
        ]);
        $a = $this->account('redx', null);
        $d = $this->driver('redx');
        $this->assertTrue($this->within(fn () => $d->checkCredentials($a))->ok);
        $r = $this->within(fn () => $d->book($this->shipment(null), $a, $this->request(['areaId' => '1'])));
        $this->assertSame(['20A316UTJZ0P', '20A316UTJZ0P'], [$r->consignmentId, $r->trackingCode]);
        Http::assertSent(fn (Request $q) => str_ends_with($q->url(), '/parcel') && $q->hasHeader('API-ACCESS-TOKEN', 'Bearer redx-access-token-9b2c')
            && $q['merchant_invoice_id'] === '01jdxk0000000000000000ship' && $q['cash_collection_amount'] === '1770'
            && $q['delivery_area_id'] === 1 && $q['parcel_weight'] === 500 && $q['pickup_store_id'] === 1234);
        $u = $this->within(fn () => $d->status($this->shipment('20A316UTJZ0P'), $a));
        $this->assertSame(['delivered', 177000], [$u->status, $u->codCollectedAmount]);
        $this->assertSame('[redacted]', $u->raw['customer_phone']);
        $this->assertSame(['1', '2'], array_map(fn ($x) => $x->id, $this->within(fn () => $d->areas($a, 'area', null))));
        $this->assertSame([], $this->within(fn () => $d->areas($a, 'city', null)));
        $this->assertSame('7001', $this->within(fn () => $d->pickupStores($a))[0]->id);
        $this->assertFalse($d->supportsWebhooks());
        $this->expectException(CourierException::class);
        $d->parseWebhook(['status' => 'delivered'], ['API-ACCESS-TOKEN' => 'x'], $a);
    }

    public function test_redx_rejection_bad_token_and_missing_area(): void
    {
        $a = $this->account('redx', null);
        try {
            $this->within(fn () => $this->driver('redx')->book($this->shipment(null), $a, $this->request(['areaId' => null])));
            $this->fail('area');
        } catch (CourierException $e) {
            $this->assertSame([CourierException::COURIER_REJECTED, 'area'], [$e->errorCode, $e->field]);
        }
        Http::fake([
            'sandbox.redx.com.bd/v1.0.0-beta/parcel' => Http::response($this->fixture('redx/create_parcel_rejected'), 422),
            'sandbox.redx.com.bd/v1.0.0-beta/areas' => Http::response(['message' => 'Unauthorized'], 401),
        ]);
        try {
            $this->within(fn () => $this->driver('redx')->book($this->shipment(null), $a, $this->request()));
            $this->fail('rejected');
        } catch (CourierException $e) {
            $this->assertSame([CourierException::COURIER_REJECTED, 'area'], [$e->errorCode, $e->field]);
        }
        $this->assertCourierError(CourierException::CREDENTIALS_INVALID, fn () => $this->within(fn () => $this->driver('redx')->checkCredentials($a)));
    }

    public function test_5xx_and_429_are_provider_unavailable_and_live_urls_come_from_config(): void
    {
        Http::fake(['*' => Http::response('oops', 503)]);
        foreach (['steadfast', 'redx'] as $p) {
            try {
                $this->within(fn () => $this->driver($p)->checkCredentials($this->account($p)));
                $this->fail($p);
            } catch (CourierException $e) {
                $this->assertSame(CourierException::PROVIDER_UNAVAILABLE, $e->errorCode);
            }
        }
        $live = $this->account('pathao');
        $live->mode = 'live';
        $this->assertSame('https://api-hermes.pathao.com', $live->baseUrl());
        $this->assertSame('https://openapi.redx.com.bd/v1.0.0-beta', CourierAccount::baseUrlFor('redx', 'live'));
        $this->assertSame('https://portal.packzy.com/api/v1', CourierAccount::baseUrlFor('steadfast', 'sandbox'));
    }

    // ---------------------------------------------------------------- Fake

    public function test_fake_courier_is_deterministic_and_drives_status_and_webhooks(): void
    {
        config(['couriers.fake' => true]);
        $fake = app(CourierManager::class)->fake('steadfast');
        $a = $this->account('steadfast');
        $r = $this->within(fn () => $fake->book($this->shipment(null), $a, $this->request()));
        $this->assertSame(FakeCourier::consignmentFor('steadfast', '01jdxk0000000000000000ship'), $r->consignmentId);
        $this->assertSame([FakeCourier::DELIVERY_FEE, 'booked'], [$r->deliveryFeeAmount, $r->providerStatus]);

        $s = $this->shipment($r->consignmentId);
        $this->assertSame('booked', $this->within(fn () => $fake->status($s, $a))->status);
        $u = $this->within(fn () => $fake->advance($s, 'delivered', location: 'Dhanmondi hub'));
        $this->assertSame(['delivered', 177000, 'Dhanmondi hub'], [$u->status, $u->codCollectedAmount, $u->location]);
        $this->assertSame('delivered', $this->within(fn () => $fake->status($s, $a))->status);

        $payload = $this->within(fn () => $fake->webhookPayload($s));
        $event = $fake->parseWebhook($payload, FakeCourier::webhookHeaders('steadfast', 'whsec-0123456789012345678901234567890123'), $a);
        $this->assertSame([$r->consignmentId, 'delivered', 177000], [$event->consignmentId, $event->update->status, $event->update->codCollectedAmount]);
        $this->assertCourierError(CourierException::WEBHOOK_UNAUTHORIZED, fn () => $fake->parseWebhook($payload, FakeCourier::webhookHeaders('steadfast', 'wrong'), $a));
    }

    public function test_fake_markers_and_credentials(): void
    {
        config(['couriers.fake' => true]);
        $fake = app(CourierManager::class)->fake('pathao');
        $a = $this->account('pathao');
        foreach (['fake:reject' => CourierException::COURIER_REJECTED, 'fake:down' => CourierException::PROVIDER_UNAVAILABLE, 'fake:timeout' => CourierException::PROVIDER_UNAVAILABLE] as $marker => $code) {
            try {
                $this->within(fn () => $fake->book($this->shipment(null), $a, $this->request(['note' => $marker, 'invoice' => $marker])));
                $this->fail($marker);
            } catch (CourierException $e) {
                $this->assertSame($code, $e->errorCode);
            }
        }
        $this->assertNull($this->within(fn () => $fake->findByInvoice('fake:down', $a)));
        $this->assertNotNull($this->within(fn () => $fake->findByInvoice('fake:timeout', $a)), 'timed-out booking exists');

        $bad = $this->account('pathao');
        $bad->credentials = ['client_id' => 'invalid-id'] + self::CREDENTIALS['pathao'];
        try {
            $fake->checkCredentials($bad);
            $this->fail('invalid');
        } catch (CourierException $e) {
            $this->assertSame([CourierException::CREDENTIALS_INVALID, 'client_id'], [$e->errorCode, $e->field]);
        }
        $this->assertSame(['bulk', 'areas', 'webhook'], $fake->capabilities());
        $this->assertSame('1', $fake->areas($a, 'city', null)[0]->id);
        $this->assertSame('11', $fake->areas($a, 'zone', '1')[0]->id);
        $this->assertNull($fake->parseWebhook(['event' => 'webhook_integration'], ['X-PATHAO-Signature' => 'whsec-0123456789012345678901234567890123'], $a));
    }
}
