<?php

declare(strict_types=1);

namespace Tests\Feature\Inbox;

use App\Domain\Inbox\Models\InboxConversation;
use App\Domain\Inbox\Models\InboxMessage;
use App\Domain\Inbox\Support\OrderAccessToken;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\ForksRaces;
use Tests\TestCase;

/** PHASE-8-8E S246 (Postgres races): one conversation per thread, one message per client_id / Message-ID, one assignee. */
#[Group('inbox')]
#[Group('race')]
class InboxRaceTest extends TestCase
{
    use ForksRaces, InboxFixtures, RefreshDatabase;

    public function test_two_first_order_messages_create_one_conversation_and_one_client_id_one_message(): void
    {
        $this->requirePostgresRace();
        try {
            $this->setUpInbox();
            Mail::fake();
            [, $tenant, $store, $h] = $this->inboxShop('race');
            [$orderId] = $this->sfOrder($h, $store);
            $access = OrderAccessToken::issue($tenant->id, $store->id, $orderId, 3600);
            $client = (string) Str::uuid();
            $results = $this->parallel(4, fn (int $i) => $this->sf($store, 'POST', '/orders/messages', ['body' => 'hello '.$i, 'client_id' => $i < 2 ? $client : (string) Str::uuid()],
                null, ['X-Order-Access' => $access])->status());
            $this->assertSame([201, 201, 201, 201], $results, json_encode($results));
            $this->assertSame(1, InboxConversation::withoutTenancy()->where('store_id', $store->id)->count());
            $this->assertSame(3, InboxMessage::withoutTenancy()->where('store_id', $store->id)->where('kind', 'customer')->count());

            // Same inbound Message-ID twice in parallel → one message.
            $key = $this->storeAddress($tenant, $store);
            $results = $this->parallel(3, fn (int $i) => $this->inbound(['recipient' => "shop-{$key}@in.storeplix.test", 'Message-Id' => '<dup@race>'])->status());
            $this->assertSame([202, 202, 202], $results);
            $this->assertSame(1, InboxMessage::withoutTenancy()->where('store_id', $store->id)->where('email_message_id', '<dup@race>')->count());
        } finally {
            $this->raceCleanup();
        }
    }

    public function test_two_verifies_of_one_phone_and_concurrent_assign(): void
    {
        $this->requirePostgresRace();
        try {
            $this->setUpInbox();
            Mail::fake();
            [, $tenant, $store, $h] = $this->inboxShop('racev');
            $tokens = [];
            $codes = [];
            for ($i = 0; $i < 2; $i++) {
                $tokens[] = $this->startChat($store, ['message' => "m{$i}"])->assertCreated()->json('data.session_token');
                $codes[] = $this->sms()->lastCodeFor(self::MSISDN);
            }
            $results = $this->parallel(2, fn (int $i) => $this->chat($store, $tokens[$i], 'POST', '/sessions/verify', ['code' => $codes[$i]])->status());
            $this->assertSame([200, 200], $results);
            $this->assertSame(1, InboxConversation::withoutTenancy()->where('store_id', $store->id)->where('channel', 'web_chat')->count());
            $id = InboxConversation::withoutTenancy()->where('store_id', $store->id)->value('id');
            $this->assertSame(2, InboxMessage::withoutTenancy()->where('conversation_id', $id)->where('kind', 'customer')->count());

            [$a] = $this->member($tenant, TenantUser::ROLE_STAFF);
            [$b] = $this->member($tenant, TenantUser::ROLE_STAFF);
            $results = $this->parallel(4, fn (int $i) => $this->api($h, 'POST', $this->iUrl($store, "/conversations/{$id}/assign"),
                ['assignee_id' => $i % 2 === 0 ? $a->id : $b->id, 'revision' => 3])->status());
            sort($results);
            $this->assertSame([200, 409, 409, 409], $results, json_encode($results));
            $this->assertSame(1, InboxMessage::withoutTenancy()->where('conversation_id', $id)->where('system_event', 'assigned')->count());
        } finally {
            $this->raceCleanup();
        }
    }
}
