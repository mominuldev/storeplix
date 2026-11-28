<?php

declare(strict_types=1);

namespace Tests\Feature\Inbox;

use App\Domain\Inbox\Jobs\SendInboxEmailReply;
use App\Domain\Inbox\Mail\InboxReplyMail;
use App\Domain\Inbox\Models\InboxConversation;
use App\Domain\Inbox\Models\InboxMessage;
use App\Domain\Inbox\Support\ReplyAddress;
use App\Domain\Orders\Mail\OrderPlacedMail;
use App\Domain\Orders\Models\Order;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Mail;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/** PHASE-8-8E §11: inbound webhook (signature, timestamp, replay, routing, loop, dedupe, trimming) and outbound mail. */
#[Group('inbox')]
#[Group('security')]
class InboxEmailTest extends TestCase
{
    use InboxFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpInbox();
        Mail::fake();
    }

    private function to(string $key): string
    {
        return 'shop-'.$key.'@in.storeplix.test';
    }

    public function test_signature_timestamp_and_replay(): void
    {
        [, $tenant, $store] = $this->inboxShop();
        $to = $this->to($this->storeAddress($tenant, $store));
        $this->inbound(['recipient' => $to], 'wrong-key')->assertStatus(401)->assertJsonPath('error.code', 'inbound_email_signature_invalid');
        $this->inbound(['recipient' => $to], timestamp: now()->subMinutes(16)->getTimestamp())->assertStatus(401);
        $this->inbound(['recipient' => $to], token: 'replayed-token-0123456789abcdef')->assertStatus(202)->assertJsonPath('data.accepted', true);
        $this->inbound(['recipient' => $to], token: 'replayed-token-0123456789abcdef')->assertStatus(401);
        $this->flushHeaders()->postJson('/api/v1/webhooks/inbound-email/mailgun', [])->assertNotFound(); // not the configured driver
        $this->assertSame(1, $this->platformQuery(InboxConversation::class)->where('tenant_id', $tenant->id)->count());
    }

    public function test_store_address_creates_an_email_conversation_with_trimmed_text(): void
    {
        [, $tenant, $store, $h] = $this->inboxShop();
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/customers", ['name' => 'Nusrat', 'email' => 'nusrat@example.test'])->assertCreated();
        $key = $this->storeAddress($tenant, $store);
        $body = "When will it arrive?\n\n-- \nNusrat\n\nOn Mon, Shop wrote:\n> old text";
        $this->inbound(['recipient' => $this->to($key), 'body-plain' => $body, 'Message-Id' => '<m1@x>',
            'attachment-1' => $this->pdfFile(), 'attachment-2' => UploadedFile::fake()->createWithContent('x.exe', 'MZ binary')])->assertStatus(202);

        $c = $this->conversationOf($tenant, 'email');
        $this->assertSame(['email:nusrat@example.test', 'email', 'Delivery?', '<m1@x>', 'Nusrat'], [$c->thread_key, $c->identity, $c->subject, $c->last_inbound_message_id, $c->contact_name]);
        $this->assertNotNull($c->customer_id); // authenticated + exactly one customer
        $msg = $this->messagesOf($tenant, $c->id)[0];
        $this->assertSame("When will it arrive?\n\n[1 attachment was not accepted]", $msg->body);
        $this->assertSame(1, $this->platformTable('inbox_attachments')->where('message_id', $msg->id)->count());

        // Duplicate Message-ID → dropped.
        $this->inbound(['recipient' => $this->to($key), 'Message-Id' => '<m1@x>'])->assertStatus(202);
        $this->assertCount(1, $this->messagesOf($tenant, $c->id));
        // Loop / bulk / auto mail → dropped.
        foreach ([['message-headers' => json_encode([['Auto-Submitted', 'auto-replied']])], ['message-headers' => json_encode([['Precedence', 'bulk']])],
            ['from' => 'MAILER-DAEMON@example.test'], ['X-Mailgun-Sflag' => 'Yes']] as $extra) {
            $this->inbound($extra + ['recipient' => $this->to($key)])->assertStatus(202);
        }
        $this->assertCount(1, $this->messagesOf($tenant, $c->id));
        $this->assertSame(1, $this->platformQuery(InboxConversation::class)->where('tenant_id', $tenant->id)->count());
    }

    public function test_unknown_addresses_bad_signatures_and_sender_mismatch(): void
    {
        [, $tenant, $store, $h] = $this->inboxShop();
        $this->inbound(['recipient' => 'shop-aaaaaaaaaaaa@in.storeplix.test'])->assertStatus(202)->assertJsonPath('data.accepted', false);
        $this->inbound(['recipient' => 'someone@elsewhere.test'])->assertStatus(202)->assertJsonPath('data.accepted', false);
        $key = $this->storeAddress($tenant, $store);
        $this->inbound(['recipient' => $this->to($key), 'X-Mailgun-Spf' => 'fail'])->assertStatus(202);
        $c = $this->conversationOf($tenant, 'email');
        $this->assertSame(['email_unverified', null], [$c->identity, $c->customer_id]);

        // Signed conversation address: forged sig ignored; right sig + other sender → a new thread of that sender.
        $address = ReplyAddress::conversation($c->id);
        $forged = 'c-'.$c->id.'-000000000000@in.storeplix.test';
        $this->inbound(['recipient' => $forged])->assertJsonPath('data.accepted', false);
        $this->inbound(['recipient' => $address, 'from' => 'other@example.test', 'body-plain' => 'Me too'])->assertStatus(202);
        $this->assertSame(2, $this->platformQuery(InboxConversation::class)->where('tenant_id', $tenant->id)->count());
        $this->inbound(['recipient' => $address, 'body-plain' => 'Following up'])->assertStatus(202);
        $this->assertCount(2, $this->messagesOf($tenant, $c->id));

        // Channel off → dropped. Rotation → the old key stops at once.
        $this->api($h, 'POST', $this->iUrl($store, '/settings/email-address/rotate'))->assertOk();
        $this->inbound(['recipient' => $this->to($key)])->assertJsonPath('data.accepted', false);
        $this->channels($h, $store, ['email_enabled' => false]);
        $this->inbound(['recipient' => $this->to($this->storeAddress($tenant, $store)), 'from' => 'late@example.test'])->assertStatus(202);
        $this->assertSame(0, $this->platformQuery(InboxConversation::class)->where('contact_email', 'late@example.test')->count());
    }

    public function test_order_address_links_the_order_and_order_email_reply_to(): void
    {
        [, $tenant, $store, $h] = $this->liveShop('mailshop');
        // Channel off: Reply-To = the store contact email (unchanged).
        [$orderId] = $this->sfOrder($h, $store);
        $order = $this->platformQuery(Order::class)->whereKey($orderId)->firstOrFail();
        $mail = fn () => $this->inTenant($tenant, fn () => (new OrderPlacedMail($order, $store->refresh(), 'shop@example.test'))->envelope());
        $this->assertSame('shop@example.test', $mail()->replyTo[0]->address);
        $this->channels($h, $store, ['email_enabled' => true]);
        $this->assertSame(ReplyAddress::order($orderId), $mail()->replyTo[0]->address);

        $this->inbound(['recipient' => ReplyAddress::order($orderId)])->assertStatus(202);
        $c = $this->conversationOf($tenant, 'email');
        $this->assertSame($orderId, $c->order_id);
        $this->assertSame('order_linked', collect($this->messagesOf($tenant, $c->id))->last()->system_event);
    }

    public function test_outbound_reply_headers_and_failure(): void
    {
        [, $tenant, $store, $h] = $this->inboxShop();
        $this->inbound(['recipient' => $this->to($this->storeAddress($tenant, $store)), 'Message-Id' => '<first@mail.test>'])->assertStatus(202);
        $c = $this->conversationOf($tenant, 'email');
        $r = $this->reply($h, $store, $c->id, 'See https://shop.test/x now')->assertCreated();
        $this->assertSame('sent', $this->platformQuery(InboxMessage::class)->whereKey($r->json('data.id'))->value('delivery_status'));
        Mail::assertSent(InboxReplyMail::class, function (InboxReplyMail $m) use ($c) {
            $env = $m->envelope();
            $headers = $m->headers();

            return $m->hasTo('nusrat@example.test') && $env->replyTo[0]->address === ReplyAddress::conversation($c->id)
                && $env->subject === 'Re: Delivery?' && $headers->references === ['first@mail.test']
                && $headers->text['In-Reply-To'] === '<first@mail.test>' && str_contains(InboxReplyMail::autolink($m->body), 'rel="nofollow noopener noreferrer"');
        });
        // Notes are never mailed.
        $this->reply($h, $store, $c->id, 'internal', ['kind' => 'note'])->assertCreated();
        Mail::assertSentCount(1);

        // Failure after the last try → failed.
        $id = $this->reply($h, $store, $c->id, 'Again')->json('data.id');
        $job = new SendInboxEmailReply($id);
        $this->platformQuery(InboxMessage::class)->whereKey($id)->update(['delivery_status' => 'queued']);
        $this->inTenant($tenant, fn () => $job->failed(new \RuntimeException('smtp down')));
        $this->assertSame('failed', $this->platformQuery(InboxMessage::class)->whereKey($id)->value('delivery_status'));
    }
}
