<?php

declare(strict_types=1);

namespace Tests\Feature\StockTransfers;

use App\Domain\Admin\Impersonation\ImpersonationService;
use App\Domain\Billing\Models\Plan;
use App\Domain\Identity\Models\User;
use App\Domain\Inventory\Models\StockTransfer;
use App\Domain\Inventory\Models\StockTransferItem;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\SpaBrowser;
use Tests\TestCase;

/**
 * PHASE-8-8C §7, §9 stock transfers: state machine with short units and cancel in transit (P88C-9, S188), send checks
 * against AVAILABLE stock (P88C-10), plan gate (S192), idempotency (S189), isolation (S187), permissions, list /
 * summary, archive blockers (P88C-17) and audit (S194).
 */
#[Group('stocktransfer')]
class StockTransfersApiTest extends TestCase
{
    use RefreshDatabase, SpaBrowser, StockTransferFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpLocations();
    }

    public function test_draft_send_and_receive_with_two_short(): void
    {
        $s = $this->transferShop(10);
        [$h, $store, $tenant, $v] = [$s['h'], $s['store'], $s['tenant'], $s['variant']];

        $draft = $this->createTransfer($h, $store, $s['main'], $s['shop'], [['variant_id' => $v, 'quantity' => 6]], ['note' => 'For the Eid display'])
            ->assertCreated()
            ->assertJsonPath('data.number', 'TR-001')
            ->assertJsonPath('data.status', 'draft')
            ->assertJsonPath('data.from_location.id', $s['main'])
            ->assertJsonPath('data.to_location.name', 'Dhanmondi shop')
            ->assertJsonPath('data.items_count', 1)
            ->assertJsonPath('data.units_sent', 6)
            ->assertJsonPath('data.units_received', null)
            ->assertJsonPath('data.units_short', 0)
            ->assertJsonPath('data.lines.0.variant.id', $v)
            ->assertJsonPath('data.lines.0.quantity', 6)
            ->assertJsonPath('data.lines.0.source_on_hand', 10)
            ->assertJsonPath('data.lines.0.source_available', 10)
            ->assertJsonPath('data.events.0.type', 'created')
            ->json('data');
        $this->assertSame(10, $this->onHand($tenant, $v, $s['main'])); // a draft moves nothing

        $sent = $this->sendTransfer($h, $store, $draft['id'])->assertOk()
            ->assertJsonPath('data.status', 'in_transit')
            ->assertJsonPath('data.revision', 2)
            ->json('data');
        $this->assertNotNull($sent['sent_at']);
        $this->assertSame(4, $this->onHand($tenant, $v, $s['main']));
        $this->assertSame(0, $this->onHand($tenant, $v, $s['shop']));
        $out = $this->ledger($tenant, $v, 'transfer_out');
        $this->assertSame([['reason' => 'transfer_out', 'delta' => -6, 'location_id' => $s['main'], 'reference_type' => 'stock_transfer', 'note' => 'TR-001 → Dhanmondi shop']], $out);

        $this->receiveTransfer($h, $store, $draft['id'], [['item_id' => $draft['lines'][0]['id'], 'received' => 4]])->assertOk()
            ->assertJsonPath('data.status', 'received')
            ->assertJsonPath('data.units_received', 4)
            ->assertJsonPath('data.units_short', 2)
            ->assertJsonPath('data.lines.0.quantity_received', 4)
            ->assertJsonPath('data.events.2.type', 'received');
        $this->assertSame(4, $this->onHand($tenant, $v, $s['main'])); // short never goes back
        $this->assertSame(4, $this->onHand($tenant, $v, $s['shop']));
        $in = $this->ledger($tenant, $v, 'transfer_in');
        $this->assertCount(1, $in); // no ledger row for the 2 short
        $this->assertSame([4, $s['shop'], 'stock_transfer', 'TR-001 → Dhanmondi shop'], [$in[0]['delta'], $in[0]['location_id'], $in[0]['reference_type'], $in[0]['note']]);

        // Movements carry the location and the reference.
        $moves = $this->api($h, 'GET', $this->lUrl($store, '/inventory/movements?filter[reference_type]=stock_transfer'))->assertOk()->json('data');
        $this->assertEqualsCanonicalizing(['transfer_out', 'transfer_in'], array_column($moves, 'reason'));

        // Wrong state: received is final.
        $this->sendTransfer($h, $store, $draft['id'])->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
        $this->api($h, 'POST', $this->lUrl($store, "/stock-transfers/{$draft['id']}/cancel"))->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
        $this->receiveTransfer($h, $store, $draft['id'], [['item_id' => $draft['lines'][0]['id'], 'received' => 0]])->assertStatus(409);
    }

    public function test_create_and_send_in_one_call_and_numbers_count_up(): void
    {
        $s = $this->transferShop(10);
        $this->createTransfer($s['h'], $s['store'], $s['main'], $s['shop'], [['variant_id' => $s['variant'], 'quantity' => 1]])->assertCreated();
        $r = $this->createTransfer($s['h'], $s['store'], $s['main'], $s['shop'], [['variant_id' => $s['variant'], 'quantity' => 3]], ['send' => true], (string) Str::uuid())
            ->assertCreated()
            ->assertJsonPath('data.number', 'TR-002')
            ->assertJsonPath('data.status', 'in_transit');
        $this->assertSame(['created', 'sent'], array_column($r->json('data.events'), 'type'));
        $this->assertSame(7, $this->onHand($s['tenant'], $s['variant'], $s['main']));

        // send: true without a key also works (the key is optional on create).
        $this->createTransfer($s['h'], $s['store'], $s['main'], $s['shop'], [['variant_id' => $s['variant'], 'quantity' => 1]], ['send' => true])
            ->assertCreated()->assertJsonPath('data.number', 'TR-003');
        // A failed create-and-send leaves nothing behind.
        $this->createTransfer($s['h'], $s['store'], $s['main'], $s['shop'], [['variant_id' => $s['variant'], 'quantity' => 99]], ['send' => true])
            ->assertUnprocessable()->assertJsonPath('error.code', 'insufficient_stock');
        $this->assertSame(3, $this->platformQuery(StockTransfer::class)->where('store_id', $s['store']->id)->count());
    }

    public function test_send_takes_only_available_stock_and_lists_every_short_line(): void
    {
        $s = $this->transferShop(5);
        [$h, $store] = [$s['h'], $s['store']];
        [, $other] = $this->stocked($h, $store, stock: 1);
        $this->manual($h, $store, $this->manualBody($s['variant'], 3))->assertCreated(); // commits 3 at main → available 2

        $id = $this->createTransfer($h, $store, $s['main'], $s['shop'], [['variant_id' => $s['variant'], 'quantity' => 3], ['variant_id' => $other, 'quantity' => 2]])
            ->assertCreated()->assertJsonPath('data.lines.0.source_available', 2)->json('data.id');
        $r = $this->sendTransfer($h, $store, $id)->assertUnprocessable()->assertJsonPath('error.code', 'insufficient_stock');
        $this->assertEqualsCanonicalizing([
            ['variant_id' => $s['variant'], 'requested' => 3, 'available' => 2],
            ['variant_id' => $other, 'requested' => 2, 'available' => 1],
        ], $r->json('error.details.lines'));
        $this->assertSame([], $this->ledger($s['tenant'], $s['variant'], 'transfer_out'));
        $this->api($h, 'GET', $this->lUrl($store, "/stock-transfers/{$id}"))->assertJsonPath('data.status', 'draft');

        // Exactly the available amount is fine; committed stays covered.
        $this->api($h, 'PATCH', $this->lUrl($store, "/stock-transfers/{$id}"), ['revision' => 1, 'lines' => [['variant_id' => $s['variant'], 'quantity' => 2]]])->assertOk();
        $this->sendTransfer($h, $store, $id)->assertOk();
        $this->assertSame(['on_hand' => 3, 'committed' => 3], $this->row($s['tenant'], $s['variant'], $s['main']));
    }

    public function test_cancel_draft_and_in_transit_and_delete(): void
    {
        $s = $this->transferShop(10);
        [$h, $store, $tenant, $v] = [$s['h'], $s['store'], $s['tenant'], $s['variant']];
        $line = [['variant_id' => $v, 'quantity' => 4]];

        $draft = $this->createTransfer($h, $store, $s['main'], $s['shop'], $line)->json('data.id');
        $this->api($h, 'POST', $this->lUrl($store, "/stock-transfers/{$draft}/cancel"))->assertOk()->assertJsonPath('data.status', 'cancelled');
        $this->assertSame(10, $this->onHand($tenant, $v, $s['main']));

        $transit = $this->createTransfer($h, $store, $s['main'], $s['shop'], $line, ['send' => true])->json('data');
        $this->assertSame(6, $this->onHand($tenant, $v, $s['main']));
        $this->api($h, 'POST', $this->lUrl($store, "/stock-transfers/{$transit['id']}/cancel"), ['revision' => 1])->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');
        $this->api($h, 'POST', $this->lUrl($store, "/stock-transfers/{$transit['id']}/cancel"), ['revision' => $transit['revision']])->assertOk()
            ->assertJsonPath('data.status', 'cancelled')->assertJsonPath('data.units_short', 0);
        $this->assertSame(10, $this->onHand($tenant, $v, $s['main'])); // exactly the sent units, once
        $this->assertSame(0, $this->onHand($tenant, $v, $s['shop']));
        $back = $this->ledger($tenant, $v, 'transfer_in');
        $this->assertSame([[4, $s['main'], 'TR-002 · Cancelled']], array_map(fn ($m) => [$m['delta'], $m['location_id'], $m['note']], $back));
        $this->api($h, 'POST', $this->lUrl($store, "/stock-transfers/{$transit['id']}/cancel"))->assertStatus(409);
        $this->receiveTransfer($h, $store, $transit['id'], [['item_id' => $transit['lines'][0]['id'], 'received' => 4]])->assertStatus(409);
        $this->assertSame(10, $this->onHand($tenant, $v, $s['main']));

        // Delete: drafts only.
        $this->api($h, 'DELETE', $this->lUrl($store, "/stock-transfers/{$transit['id']}"))->assertStatus(409);
        $d2 = $this->createTransfer($h, $store, $s['main'], $s['shop'], $line)->json('data.id');
        $this->api($h, 'DELETE', $this->lUrl($store, "/stock-transfers/{$d2}"))->assertNoContent();
        $this->api($h, 'GET', $this->lUrl($store, "/stock-transfers/{$d2}"))->assertNotFound();
        $this->assertSame(0, $this->platformQuery(StockTransferItem::class)->where('stock_transfer_id', $d2)->count());
    }

    public function test_edit_draft_with_revision(): void
    {
        $s = $this->transferShop(10);
        [$h, $store] = [$s['h'], $s['store']];
        [, $other] = $this->stocked($h, $store, stock: 3);
        $hub = $this->addLocation($h, $store, 'Chattogram hub', 'warehouse')['id'];
        $id = $this->createTransfer($h, $store, $s['main'], $s['shop'], [['variant_id' => $s['variant'], 'quantity' => 1]])->json('data.id');

        $this->api($h, 'PATCH', $this->lUrl($store, "/stock-transfers/{$id}"), ['note' => 'x'])->assertUnprocessable()->assertJsonValidationErrors(['revision'], 'error.details');
        $this->api($h, 'PATCH', $this->lUrl($store, "/stock-transfers/{$id}"), ['revision' => 1, 'to_location_id' => $hub, 'note' => 'Hub run',
            'lines' => [['variant_id' => $other, 'quantity' => 2], ['variant_id' => $s['variant'], 'quantity' => 5]]])->assertOk()
            ->assertJsonPath('data.revision', 2)
            ->assertJsonPath('data.to_location.name', 'Chattogram hub')
            ->assertJsonPath('data.note', 'Hub run')
            ->assertJsonPath('data.items_count', 2)
            ->assertJsonPath('data.units_sent', 7)
            ->assertJsonPath('data.lines.0.variant.id', $other);
        $this->api($h, 'PATCH', $this->lUrl($store, "/stock-transfers/{$id}"), ['revision' => 1, 'note' => 'stale'])
            ->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');
        $this->api($h, 'PATCH', $this->lUrl($store, "/stock-transfers/{$id}"), ['revision' => 2, 'from_location_id' => $hub])
            ->assertUnprocessable()->assertJsonValidationErrors(['to_location_id'], 'error.details');

        $this->sendTransfer($h, $store, $id)->assertOk();
        $this->api($h, 'PATCH', $this->lUrl($store, "/stock-transfers/{$id}"), ['revision' => 3, 'note' => 'late'])
            ->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
    }

    public function test_validation(): void
    {
        $s = $this->transferShop(10);
        [$h, $store, $v] = [$s['h'], $s['store'], $s['variant']];
        $url = $this->lUrl($store, '/stock-transfers');
        $ok = ['from_location_id' => $s['main'], 'to_location_id' => $s['shop'], 'lines' => [['variant_id' => $v, 'quantity' => 1]]];

        $this->api($h, 'POST', $url, [])->assertUnprocessable()->assertJsonValidationErrors(['from_location_id', 'to_location_id', 'lines'], 'error.details');
        $this->api($h, 'POST', $url, ['to_location_id' => $s['main']] + $ok)->assertUnprocessable()->assertJsonValidationErrors(['to_location_id'], 'error.details');
        $this->api($h, 'POST', $url, ['lines' => [['variant_id' => $v, 'quantity' => 0]]] + $ok)->assertUnprocessable()->assertJsonValidationErrors(['lines.0.quantity'], 'error.details');
        $this->api($h, 'POST', $url, ['lines' => [['variant_id' => $v, 'quantity' => 100001]]] + $ok)->assertUnprocessable();
        $this->api($h, 'POST', $url, ['lines' => [['variant_id' => $v, 'quantity' => 1], ['variant_id' => strtoupper($v), 'quantity' => 1]]] + $ok)
            ->assertUnprocessable()->assertJsonValidationErrors(['lines.1.variant_id'], 'error.details');
        $this->api($h, 'POST', $url, ['lines' => array_fill(0, 201, ['variant_id' => $v, 'quantity' => 1])] + $ok)->assertUnprocessable();
        $this->api($h, 'POST', $url, ['note' => str_repeat('a', 501)] + $ok)->assertUnprocessable()->assertJsonValidationErrors(['note'], 'error.details');
        $this->api($h, 'POST', $url, ['lines' => [['variant_id' => strtolower((string) Str::ulid()), 'quantity' => 1]]] + $ok)
            ->assertUnprocessable()->assertJsonValidationErrors(['lines.0.variant_id'], 'error.details');
        [, $untracked] = $this->stocked($h, $store, stock: 0, variant: ['track_inventory' => false]);
        $this->api($h, 'POST', $url, ['lines' => [['variant_id' => $untracked, 'quantity' => 1]]] + $ok)
            ->assertUnprocessable()->assertJsonPath('error.code', 'variant_not_tracked');

        // Archived location → 422 location_archived (create, and send of a draft whose location was archived meanwhile
        // is impossible: an open transfer blocks archiving — P88C-17).
        $old = $this->addLocation($h, $store, 'Old godown', 'warehouse')['id'];
        $this->api($h, 'POST', $this->lUrl($store, "/locations/{$old}/archive"))->assertOk();
        $this->api($h, 'POST', $url, ['to_location_id' => $old] + $ok)->assertUnprocessable()->assertJsonPath('error.code', 'location_archived');

        // Receive: every line once, 0 ≤ received ≤ quantity.
        [, $other] = $this->stocked($h, $store, stock: 5);
        $t = $this->createTransfer($h, $store, $s['main'], $s['shop'], [['variant_id' => $v, 'quantity' => 2], ['variant_id' => $other, 'quantity' => 1]], ['send' => true])->json('data');
        [$a, $b] = [$t['lines'][0]['id'], $t['lines'][1]['id']];
        $this->receiveTransfer($h, $store, $t['id'], [['item_id' => $a, 'received' => 2]])->assertUnprocessable()->assertJsonValidationErrors(['lines'], 'error.details');
        $this->receiveTransfer($h, $store, $t['id'], [['item_id' => $a, 'received' => 3], ['item_id' => $b, 'received' => 1]])
            ->assertUnprocessable()->assertJsonValidationErrors(['lines.0.received'], 'error.details');
        $this->receiveTransfer($h, $store, $t['id'], [['item_id' => $a, 'received' => -1], ['item_id' => $b, 'received' => 1]])->assertUnprocessable();
        $this->receiveTransfer($h, $store, $t['id'], [['item_id' => $a, 'received' => 1], ['item_id' => $a, 'received' => 1]])->assertUnprocessable();
        $this->receiveTransfer($h, $store, $t['id'], [])->assertUnprocessable();
        $this->receiveTransfer($h, $store, $t['id'], [['item_id' => $a, 'received' => 2], ['item_id' => $b, 'received' => 0]])->assertOk()
            ->assertJsonPath('data.units_short', 1);
    }

    #[Group('security')]
    public function test_plan_gate_blocks_create_update_send_but_not_receive_or_cancel(): void
    {
        $s = $this->transferShop(10);
        [$h, $store, $tenant] = [$s['h'], $s['store'], $s['tenant']];
        $line = [['variant_id' => $s['variant'], 'quantity' => 2]];
        $draft = $this->createTransfer($h, $store, $s['main'], $s['shop'], $line)->json('data.id');
        $transit = $this->createTransfer($h, $store, $s['main'], $s['shop'], $line, ['send' => true])->json('data');
        $transit2 = $this->createTransfer($h, $store, $s['main'], $s['shop'], $line, ['send' => true])->json('data.id');

        $this->planFor($tenant, Plan::STARTER); // downgrade (Q228)
        $this->createTransfer($h, $store, $s['main'], $s['shop'], $line)->assertStatus(402)->assertJsonPath('error.code', 'feature_not_in_plan');
        $this->api($h, 'POST', $this->lUrl($store, '/stock-transfers'), [])->assertStatus(402); // before validation
        $this->api($h, 'PATCH', $this->lUrl($store, "/stock-transfers/{$draft}"), ['revision' => 1, 'note' => 'x'])->assertStatus(402);
        $this->sendTransfer($h, $store, $draft)->assertStatus(402);
        // Reads, receive and cancel of existing transfers keep working; a draft can still be cancelled or deleted.
        $this->api($h, 'GET', $this->lUrl($store, '/stock-transfers'))->assertOk()->assertJsonPath('meta.counts.all', 3);
        $this->receiveTransfer($h, $store, $transit['id'], [['item_id' => $transit['lines'][0]['id'], 'received' => 2]])->assertOk();
        $this->api($h, 'POST', $this->lUrl($store, "/stock-transfers/{$transit2}/cancel"))->assertOk();
        $this->api($h, 'DELETE', $this->lUrl($store, "/stock-transfers/{$draft}"))->assertNoContent();
        $this->assertSame(8, $this->onHand($tenant, $s['variant'], $s['main']));
        $this->assertSame(2, $this->onHand($tenant, $s['variant'], $s['shop']));
    }

    #[Group('security')]
    public function test_idempotent_send_receive_and_create(): void
    {
        $s = $this->transferShop(10);
        [$h, $store, $tenant, $v] = [$s['h'], $s['store'], $s['tenant'], $s['variant']];
        $t = $this->createTransfer($h, $store, $s['main'], $s['shop'], [['variant_id' => $v, 'quantity' => 3]])->json('data');

        $this->api($h, 'POST', $this->lUrl($store, "/stock-transfers/{$t['id']}/send"))->assertStatus(400)->assertJsonPath('error.code', 'idempotency_key_required');
        $key = (string) Str::uuid();
        $first = $this->sendTransfer($h, $store, $t['id'], $key)->assertOk()->json('data');
        $this->sendTransfer($h, $store, $t['id'], $key)->assertOk()->assertHeader('Idempotent-Replayed', 'true')->assertJsonPath('data.revision', $first['revision']);
        $this->sendTransfer($h, $store, $t['id'])->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
        $this->assertCount(1, $this->ledger($tenant, $v, 'transfer_out'));
        $this->assertSame(7, $this->onHand($tenant, $v, $s['main']));

        $rkey = (string) Str::uuid();
        $lines = [['item_id' => $t['lines'][0]['id'], 'received' => 3]];
        $this->receiveTransfer($h, $store, $t['id'], $lines, $rkey)->assertOk();
        $this->receiveTransfer($h, $store, $t['id'], $lines, $rkey)->assertOk()->assertHeader('Idempotent-Replayed', 'true');
        $this->receiveTransfer($h, $store, $t['id'], [['item_id' => $t['lines'][0]['id'], 'received' => 2]], $rkey)
            ->assertStatus(409)->assertJsonPath('error.code', 'idempotency_key_mismatch');
        $this->assertCount(1, $this->ledger($tenant, $v, 'transfer_in'));
        $this->assertSame(3, $this->onHand($tenant, $v, $s['shop']));

        // Create-and-send retried with the same key → one transfer, one ledger row.
        $ckey = (string) Str::uuid();
        $body = [['variant_id' => $v, 'quantity' => 1]];
        $a = $this->createTransfer($h, $store, $s['main'], $s['shop'], $body, ['send' => true], $ckey)->assertCreated()->json('data.id');
        $b = $this->createTransfer($h, $store, $s['main'], $s['shop'], $body, ['send' => true], $ckey)->assertCreated()->assertHeader('Idempotent-Replayed', 'true')->json('data.id');
        $this->assertSame($a, $b);
        $this->assertCount(2, $this->ledger($tenant, $v, 'transfer_out'));
        $this->assertSame(6, $this->onHand($tenant, $v, $s['main']));
    }

    #[Group('security')]
    public function test_permissions(): void
    {
        $s = $this->transferShop(10);
        [$h, $store, $tenant] = [$s['h'], $s['store'], $s['tenant']];
        $id = $this->createTransfer($h, $store, $s['main'], $s['shop'], [['variant_id' => $s['variant'], 'quantity' => 1]])->json('data.id');

        [, $viewer] = $this->memberWithRole($tenant, $this->customRole($h, 'Viewer', ['orders.view']));
        $this->api($viewer, 'GET', $this->lUrl($store, '/stock-transfers'))->assertOk();
        $this->api($viewer, 'GET', $this->lUrl($store, '/stock-transfers/summary'))->assertOk();
        $this->api($viewer, 'GET', $this->lUrl($store, "/stock-transfers/{$id}"))->assertOk();
        $this->createTransfer($viewer, $store, $s['main'], $s['shop'], [['variant_id' => $s['variant'], 'quantity' => 1]])->assertForbidden();
        $this->api($viewer, 'PATCH', $this->lUrl($store, "/stock-transfers/{$id}"), ['revision' => 1])->assertForbidden();
        $this->api($viewer, 'DELETE', $this->lUrl($store, "/stock-transfers/{$id}"))->assertForbidden();
        $this->sendTransfer($viewer, $store, $id)->assertForbidden();
        $this->receiveTransfer($viewer, $store, $id, [])->assertForbidden();
        $this->api($viewer, 'POST', $this->lUrl($store, "/stock-transfers/{$id}/cancel"))->assertForbidden();

        // Staff hold inventory.adjust (P88C-14).
        [, $staff] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $this->sendTransfer($staff, $store, $id)->assertOk();
    }

    #[Group('security')]
    public function test_cross_tenant_and_cross_store_isolation(): void
    {
        $a = $this->transferShop(10, 'alpha');
        $b = $this->transferShop(10, 'beta');
        $bt = $this->createTransfer($b['h'], $b['store'], $b['main'], $b['shop'], [['variant_id' => $b['variant'], 'quantity' => 2]], ['send' => true])->json('data');
        $this->createTransfer($a['h'], $a['store'], $a['main'], $a['shop'], [['variant_id' => $a['variant'], 'quantity' => 2]])->assertCreated();

        // Tenant A naming B's transfer under A's store → 404; B's store with A's tenant header → 404.
        $k = ['Idempotency-Key' => (string) Str::uuid()];
        $base = $this->lUrl($a['store'], "/stock-transfers/{$bt['id']}");
        $this->assertTenantIsolation($a['h'], [
            ['GET', $base], ['PATCH', $base, ['revision' => 1, 'note' => 'x']], ['DELETE', $base], ['POST', "{$base}/cancel"],
        ]);
        $this->assertTenantIsolation($a['h'] + $k, [['POST', "{$base}/send"], ['POST', "{$base}/receive", ['lines' => [['item_id' => $bt['lines'][0]['id'], 'received' => 1]]]]]);
        $this->api($a['h'], 'GET', $this->lUrl($b['store'], '/stock-transfers'))->assertNotFound();
        $this->api($a['h'], 'GET', $this->lUrl($a['store'], '/stock-transfers'))->assertOk()->assertJsonPath('meta.total', 1);

        // Foreign location / variant ids in a body are unknown (422), never used.
        $this->createTransfer($a['h'], $a['store'], $a['main'], $b['shop'], [['variant_id' => $a['variant'], 'quantity' => 1]])
            ->assertUnprocessable()->assertJsonValidationErrors(['to_location_id'], 'error.details');
        $this->createTransfer($a['h'], $a['store'], $a['main'], $a['shop'], [['variant_id' => $b['variant'], 'quantity' => 1]])
            ->assertUnprocessable()->assertJsonValidationErrors(['lines.0.variant_id'], 'error.details');

        $this->assertStoreIsolation(StockTransfer::class, $a['tenant'], $a['store'], $b['store']);
        $this->assertStoreIsolation(StockTransferItem::class, $a['tenant'], $a['store'], $b['store']);
        $this->assertSame(8, $this->onHand($b['tenant'], $b['variant'], $b['main']));
    }

    public function test_list_filters_counts_and_summary(): void
    {
        $s = $this->transferShop(50);
        [$h, $store] = [$s['h'], $s['store']];
        $hub = $this->addLocation($h, $store, 'Chattogram hub', 'warehouse')['id'];
        $line = fn (int $q) => [['variant_id' => $s['variant'], 'quantity' => $q]];
        $this->createTransfer($h, $store, $s['main'], $s['shop'], $line(1))->assertCreated();                       // TR-001 draft
        $this->createTransfer($h, $store, $s['main'], $s['shop'], $line(2), ['send' => true])->assertCreated();     // TR-002 in transit
        $t3 = $this->createTransfer($h, $store, $s['main'], $hub, $line(5), ['send' => true])->json('data');        // TR-003 received 4/5
        $this->receiveTransfer($h, $store, $t3['id'], [['item_id' => $t3['lines'][0]['id'], 'received' => 4]])->assertOk();
        $t4 = $this->createTransfer($h, $store, $hub, $s['shop'], $line(1))->json('data.id');                    // TR-004 cancelled
        $this->api($h, 'POST', $this->lUrl($store, "/stock-transfers/{$t4}/cancel"))->assertOk();

        $list = $this->api($h, 'GET', $this->lUrl($store, '/stock-transfers'))->assertOk()
            ->assertJsonPath('meta.counts', ['all' => 4, 'draft' => 1, 'in_transit' => 1, 'received' => 1, 'cancelled' => 1])->json('data');
        $this->assertSame(['TR-004', 'TR-003', 'TR-002', 'TR-001'], array_column($list, 'number'));
        $this->assertSame([null, 4, null, null], array_column($list, 'units_received'));
        $this->assertSame([0, 1, 0, 0], array_column($list, 'units_short'));
        $this->api($h, 'GET', $this->lUrl($store, '/stock-transfers?filter[status]=draft,in_transit'))->assertOk()->assertJsonCount(2, 'data');
        $this->api($h, 'GET', $this->lUrl($store, "/stock-transfers?filter[location_id]={$hub}"))->assertOk()
            ->assertJsonPath('meta.total', 2)->assertJsonPath('meta.counts.all', 2);
        $this->api($h, 'GET', $this->lUrl($store, '/stock-transfers?q=tr-00'))->assertOk()->assertJsonPath('meta.total', 4);
        $this->api($h, 'GET', $this->lUrl($store, '/stock-transfers?q=003'))->assertOk()->assertJsonPath('data.0.number', 'TR-003')->assertJsonPath('meta.total', 1);
        $this->api($h, 'GET', $this->lUrl($store, '/stock-transfers?q=%25'))->assertOk()->assertJsonPath('meta.total', 0); // literal %
        $this->api($h, 'GET', $this->lUrl($store, '/stock-transfers?filter[status]=lost'))->assertUnprocessable();
        $this->api($h, 'GET', $this->lUrl($store, '/stock-transfers?q='.str_repeat('a', 41)))->assertUnprocessable();

        $this->api($h, 'GET', $this->lUrl($store, '/stock-transfers/summary'))->assertOk()
            ->assertJsonPath('data.drafts_count', 1)
            ->assertJsonPath('data.in_transit_count', 1)
            ->assertJsonPath('data.in_transit_units', 2)
            ->assertJsonPath('data.received_this_month_count', 1)
            ->assertJsonPath('data.received_this_month_units', 4)
            ->assertJsonPath('data.locations', ['count' => 3, 'names' => ['Main warehouse', 'Dhanmondi shop', 'Chattogram hub']]);
    }

    public function test_open_transfers_and_counts_block_archiving(): void
    {
        $s = $this->transferShop(10);
        [$h, $store] = [$s['h'], $s['store']];
        $hub = $this->addLocation($h, $store, 'Chattogram hub', 'warehouse')['id'];
        $id = $this->createTransfer($h, $store, $s['main'], $hub, [['variant_id' => $s['variant'], 'quantity' => 1]])->json('data.id');
        $this->api($h, 'POST', $this->lUrl($store, "/locations/{$hub}/archive"))->assertStatus(409)
            ->assertJsonPath('error.code', 'location_in_use')->assertJsonPath('error.details.reasons', ['open_transfers']);
        $this->api($h, 'POST', $this->lUrl($store, "/stock-transfers/{$id}/cancel"))->assertOk();

        $count = $this->startCount($h, $store, $hub)->assertCreated()->json('data.id');
        $this->api($h, 'POST', $this->lUrl($store, "/locations/{$hub}/archive"))->assertStatus(409)->assertJsonPath('error.details.reasons', ['open_counts']);
        $this->api($h, 'POST', $this->lUrl($store, "/stock-counts/{$count}/cancel"))->assertOk();
        $this->api($h, 'POST', $this->lUrl($store, "/locations/{$hub}/archive"))->assertOk();
    }

    #[Group('security')]
    public function test_audit_with_actor_and_impersonation_is_read_only(): void
    {
        $s = $this->transferShop(10);
        [$h, $store, $tenant] = [$s['h'], $s['store'], $s['tenant']];
        $line = [['variant_id' => $s['variant'], 'quantity' => 2]];
        $a = $this->createTransfer($h, $store, $s['main'], $s['shop'], $line)->json('data');
        $this->api($h, 'PATCH', $this->lUrl($store, "/stock-transfers/{$a['id']}"), ['revision' => 1, 'note' => 'n'])->assertOk();
        $this->sendTransfer($h, $store, $a['id'])->assertOk();
        $this->receiveTransfer($h, $store, $a['id'], [['item_id' => $a['lines'][0]['id'], 'received' => 2]])->assertOk();
        $b = $this->createTransfer($h, $store, $s['main'], $s['shop'], $line)->json('data.id');
        $this->api($h, 'POST', $this->lUrl($store, "/stock-transfers/{$b}/cancel"))->assertOk();
        $c = $this->createTransfer($h, $store, $s['main'], $s['shop'], $line)->json('data.id');
        $this->api($h, 'DELETE', $this->lUrl($store, "/stock-transfers/{$c}"))->assertNoContent();

        $owner = $this->platformQuery(TenantUser::class)->where('tenant_id', $tenant->id)->value('user_id');
        $rows = $this->platformTable('audit_logs')->where('tenant_id', $tenant->id)->where('action', 'like', 'stock_transfer.%')->get();
        foreach (['created', 'updated', 'sent', 'received', 'cancelled', 'deleted'] as $what) {
            $row = $rows->firstWhere('action', "stock_transfer.{$what}");
            $this->assertNotNull($row, $what);
            $this->assertSame('stock_transfer', $row->subject_type);
            $this->assertSame($owner, $row->actor_id);
        }
        $sent = json_decode((string) $rows->firstWhere('action', 'stock_transfer.sent')->meta, true);
        $this->assertSame([['variant_id' => $s['variant'], 'quantity' => 2]], $sent['lines']);
        $received = json_decode((string) $rows->firstWhere('action', 'stock_transfer.received')->meta, true);
        $this->assertSame(0, $received['units_short']);

        // Impersonation (support staff) reads but can't write.
        $draft = $this->createTransfer($h, $store, $s['main'], $s['shop'], $line)->json('data.id');
        $this->useSpaBrowser();
        Mail::fake();
        $support = User::factory()->create();
        $support->forceFill(['platform_role' => 'support'])->save();
        [, $url] = app(ImpersonationService::class)->create($support, $tenant, 'Customer ticket: transfer check', 'ZD-91', '127.0.0.1', 'phpunit');
        $this->unencryptedCookies = [];
        $this->browser('GET', '/sanctum/csrf-cookie');
        $this->browser('POST', '/api/v1/auth/impersonation', ['ticket' => Str::after($url, '#ticket=')])->assertOk();
        $t = ['X-Tenant-Id' => $tenant->id];
        $this->browser('GET', $this->lUrl($store, "/stock-transfers/{$draft}"), [], $t)->assertOk();
        $this->browser('POST', $this->lUrl($store, "/stock-transfers/{$draft}/send"), [], $t + ['Idempotency-Key' => (string) Str::uuid()])
            ->assertForbidden()->assertJsonPath('error.code', 'impersonation_read_only');
        $this->browser('POST', $this->lUrl($store, '/stock-counts'), ['location_id' => $s['main']], $t)->assertForbidden();
    }

    public function test_stock_write_limiter_covers_transfer_writes(): void
    {
        $this->app->forgetInstance(ThrottleRequests::class);
        $s = $this->transferShop(10);
        $route = app('router')->getRoutes()->getByName('stores.stock-transfers.send');
        $this->assertContains('throttle:stock-write', $route->gatherMiddleware());
        foreach (['stores.stock-transfers.store', 'stores.stock-transfers.update', 'stores.stock-transfers.destroy', 'stores.stock-transfers.receive',
            'stores.stock-transfers.cancel', 'stores.stock-counts.store', 'stores.stock-counts.scan', 'stores.stock-counts.lines.update',
            'stores.stock-counts.finish', 'stores.stock-counts.cancel'] as $name) {
            $this->assertContains('throttle:stock-write', app('router')->getRoutes()->getByName($name)->gatherMiddleware(), $name);
        }
        $this->assertNotContains('throttle:stock-write', app('router')->getRoutes()->getByName('stores.stock-transfers.index')->gatherMiddleware());
        $this->api($s['h'], 'GET', $this->lUrl($s['store'], '/stock-transfers'))->assertOk();
    }
}
