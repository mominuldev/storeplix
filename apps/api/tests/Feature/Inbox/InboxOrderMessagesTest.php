<?php

declare(strict_types=1);

namespace Tests\Feature\Inbox;

use App\Domain\Inbox\Jobs\SendInboxReplySms;
use App\Domain\Inbox\Support\OrderAccessToken;
use App\Domain\Inbox\WidgetService;
use App\Domain\Stores\Models\Store;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/** PHASE-8-8E §10: `messages` on track / confirmation / access, order token binding, order conversation, isolation. */
#[Group('inbox')]
#[Group('security')]
class InboxOrderMessagesTest extends TestCase
{
    use InboxFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpInbox();
        Mail::fake();
    }

    private function om(Store $store, string $access, string $method, string $path = '', array $body = []): TestResponse
    {
        return $this->sf($store, $method, '/orders/messages'.$path, $body, null, ['X-Order-Access' => $access]);
    }

    public function test_confirmation_track_and_access_carry_messages_only_when_the_channel_is_on(): void
    {
        [, $tenant, $store, $h] = $this->liveShop('orders');
        [$orderId, $number, $confirmation] = $this->sfOrder($h, $store);

        // Channel off (no settings row): no `messages` key at all (the answer is exactly the pre-8.8e one).
        $this->sf($store, 'GET', '/orders/confirmation', [], null, ['X-Order-Token' => $confirmation])->assertOk()->assertJsonMissingPath('data.messages');
        $this->sf($store, 'POST', '/orders/track', ['number' => $number, 'phone' => '01711000001'])->assertOk()->assertJsonMissingPath('data.messages');

        $this->channels($h, $store, ['order_messages_enabled' => true]);
        $c = $this->sf($store, 'GET', '/orders/confirmation', [], null, ['X-Order-Token' => $confirmation])->assertOk();
        $c->assertJsonPath('data.messages.enabled', true)->assertJsonPath('data.messages.unread_count', 0)->assertJsonPath('data.messages.reply_time', 'minutes');
        $this->assertSame(['enabled', 'access_token', 'unread_count', 'reply_time'], array_keys($c->json('data.messages')));
        $access = $this->sf($store, 'POST', '/orders/track', ['number' => $number, 'phone' => '01711000001'])->assertOk()->json('data.messages.access_token');

        $this->sf($store, 'GET', '/orders/access', [], null, ['X-Order-Access' => $access])->assertOk()
            ->assertJsonPath('data.number', $number)->assertJsonPath('data.messages.enabled', true);
        $this->sf($store, 'GET', '/orders/access', [], null, ['X-Order-Access' => $access.'x'])->assertNotFound()->assertJsonPath('error.code', 'order_access_invalid');

        // Expiry: 12 h from track.
        $this->travel(13)->hours();
        $this->sf($store, 'GET', '/orders/access', [], null, ['X-Order-Access' => $access])->assertNotFound();
    }

    public function test_first_message_creates_the_order_conversation_and_replies_text_the_order_phone(): void
    {
        Bus::fake([SendInboxReplySms::class]);
        [, $tenant, $store, $h] = $this->inboxShop();
        [$orderId, $number] = $this->sfOrder($h, $store);
        $access = OrderAccessToken::issue($tenant->id, $store->id, $orderId, 3600);

        $this->om($store, $access, 'GET')->assertOk()->assertJsonPath('data', []);
        $client = (string) Str::uuid();
        $this->om($store, $access, 'POST', '', ['body' => 'Can I change the size?', 'client_id' => $client])->assertCreated()->assertJsonPath('data.from', 'customer');
        $this->om($store, $access, 'POST', '', ['body' => 'Can I change the size?', 'client_id' => $client])->assertCreated();
        $c = $this->conversationOf($tenant, 'order');
        $this->assertSame(['order:'.$orderId, 'order_access', $orderId, '8801711000001', 1],
            [$c->thread_key, $c->identity, $c->order_id, $c->contact_phone, count($this->messagesOf($tenant, $c->id))]);
        $this->assertNotNull($c->customer_id);

        $this->api($h, 'GET', $this->iUrl($store, "/conversations/{$c->id}"))->assertJsonPath('data.order.number', $number)
            ->assertJsonPath('data.can.link_order', false)->assertJsonPath('data.customer.customer.id', $c->customer_id);
        $this->api($h, 'PUT', $this->iUrl($store, "/conversations/{$c->id}/order"), ['order_id' => null])->assertUnprocessable()
            ->assertJsonPath('error.code', 'inbox_order_locked');
        $this->reply($h, $store, $c->id, 'Sure')->assertCreated()->assertJsonPath('data.sms_status', 'pending');
        $this->om($store, $access, 'GET')->assertOk()->assertJsonCount(2, 'data')->assertJsonPath('data.1.from', 'shop');
        $this->om($store, $access, 'POST', '/seen')->assertNoContent();
    }

    public function test_customer_rows_show_seen_once_a_member_reads_them_and_the_etag_changes(): void
    {
        Bus::fake([SendInboxReplySms::class]);
        [, $tenant, $store, $h] = $this->inboxShop();
        [$orderId] = $this->sfOrder($h, $store);
        $access = OrderAccessToken::issue($tenant->id, $store->id, $orderId, 3600);
        $this->om($store, $access, 'POST', '', ['body' => 'Is it shipped?', 'client_id' => (string) Str::uuid()])->assertCreated()
            ->assertJsonPath('data.seen', false);
        $c = $this->conversationOf($tenant, 'order');
        $first = $this->om($store, $access, 'GET')->assertOk()->assertJsonPath('data.0.from', 'customer')->assertJsonPath('data.0.seen', false);
        $etag = (string) $first->headers->get('ETag');
        $this->sf($store, 'GET', '/orders/messages', [], null, ['X-Order-Access' => $access, 'If-None-Match' => $etag])->assertStatus(304);

        // A member reads it: the shopper's bubble says "Seen" (Figma 2126:10642) and the old ETag no longer matches.
        $this->api($h, 'POST', $this->iUrl($store, "/conversations/{$c->id}/read"), ['last_read_message_id' => $first->json('data.0.id')])->assertNoContent();
        $this->sf($store, 'GET', '/orders/messages', [], null, ['X-Order-Access' => $access, 'If-None-Match' => $etag])->assertOk()
            ->assertJsonPath('data.0.seen', true);

        // A reply row's `seen` still means the shopper saw it.
        $this->reply($h, $store, $c->id, 'Yes, today')->assertCreated();
        $this->om($store, $access, 'GET')->assertJsonPath('data.1.from', 'shop')->assertJsonPath('data.1.seen', false);
        $this->om($store, $access, 'POST', '/seen')->assertNoContent();
        $this->om($store, $access, 'GET')->assertJsonPath('data.1.seen', true)->assertJsonPath('data.0.seen', true);
    }

    public function test_tokens_are_bound_to_tenant_and_store(): void
    {
        [, $tenantA, $storeA, $hA] = $this->inboxShop('alpha');
        [, $tenantB, $storeB] = $this->inboxShop('beta');
        [$orderA] = $this->sfOrder($hA, $storeA);
        $tokenA = OrderAccessToken::issue($tenantA->id, $storeA->id, $orderA, 3600);
        $this->om($storeB, $tokenA, 'GET')->assertNotFound()->assertJsonPath('error.code', 'order_access_invalid');
        $this->om($storeB, $tokenA, 'POST', '', ['body' => 'x', 'client_id' => (string) Str::uuid()])->assertNotFound();
        $forged = OrderAccessToken::issue($tenantB->id, $storeB->id, $orderA, 3600); // right shape, wrong store
        $this->om($storeB, $forged, 'GET')->assertNotFound();
        $this->om($storeA, $tokenA, 'GET')->assertOk();

        $this->channels($hA, $storeA, ['order_messages_enabled' => false]);
        $this->om($storeA, $tokenA, 'GET')->assertNotFound()->assertJsonPath('error.code', 'inbox_unavailable');
    }

    public function test_magic_link_for_an_order_conversation_returns_an_access_token(): void
    {
        [, $tenant, $store, $h] = $this->inboxShop();
        [$orderId, $number] = $this->sfOrder($h, $store);
        $access = OrderAccessToken::issue($tenant->id, $store->id, $orderId, 3600);
        $this->om($store, $access, 'POST', '', ['body' => 'Hello', 'client_id' => (string) Str::uuid()])->assertCreated();
        $c = $this->conversationOf($tenant, 'order');
        $code = $this->inTenant($tenant, fn () => app(WidgetService::class)->magicLink($c));
        $r = $this->sf($store, 'POST', "/inbox/links/{$code}")->assertOk()->assertJsonPath('data.kind', 'order')->assertJsonPath('data.number', $number);
        $this->om($store, $r->json('data.access_token'), 'GET')->assertOk()->assertJsonCount(1, 'data');
    }
}
