<?php

declare(strict_types=1);

namespace Tests\Feature\Inbox;

use App\Domain\Inbox\Jobs\SendInboxReplySms;
use App\Domain\Inbox\Mail\InboxAssignedMail;
use App\Domain\Inbox\Models\InboxAttachment;
use App\Domain\Inbox\Models\InboxConversation;
use App\Domain\Inbox\Models\InboxMessage;
use App\Domain\Inbox\Models\InboxRead;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Bus;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/** PHASE-8-8E §5–§6: list, summary, thread, messages, send, actions, unread, ETag/304, isolation. */
#[Group('inbox')]
class InboxConversationsApiTest extends TestCase
{
    use InboxFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpInbox();
        Mail::fake();
    }

    public function test_a_verified_chat_lands_in_the_list_with_unread_and_summary(): void
    {
        [$owner, $tenant, $store, $h] = $this->inboxShop();
        [, $id] = $this->verifiedChat($tenant, $store, 'Do you have size L?');

        $list = $this->api($h, 'GET', $this->iUrl($store, '/conversations'))->assertOk();
        $list->assertJsonPath('data.0.id', $id)->assertJsonPath('data.0.channel', 'web_chat')->assertJsonPath('data.0.identity', 'verified_phone')
            ->assertJsonPath('data.0.contact.phone', self::PHONE)->assertJsonPath('data.0.preview', 'Do you have size L?')
            ->assertJsonPath('data.0.unread_count', 1)->assertJsonPath('data.0.assignee', null)->assertJsonPath('data.0.blocked', false)
            ->assertJsonPath('meta.counts', ['open' => 1, 'pending' => 0, 'closed' => 0])->assertJsonPath('meta.per_page', 30);
        $this->assertNotNull($list->headers->get('ETag'));

        $this->api($h, 'GET', $this->iUrl($store, '/summary'))->assertOk()->assertJsonPath('data', [
            'unread' => 1, 'open' => 1, 'pending' => 0, 'mine_open' => 0, 'unassigned_open' => 1,
            'channels_enabled' => ['web_chat' => true, 'order_messages' => true, 'email' => true],
        ]);

        $show = $this->api($h, 'GET', $this->iUrl($store, "/conversations/{$id}"))->assertOk();
        $show->assertJsonPath('data.can.reply', true)->assertJsonPath('data.can.delete', true)->assertJsonPath('data.customer.contact.name', 'Rafi Ahmed')
            ->assertJsonPath('data.revision', 2)->assertJsonPath('data.first_response_seconds', null);

        $messages = $this->api($h, 'GET', $this->iUrl($store, "/conversations/{$id}/messages"))->assertOk()->json('data');
        $this->assertCount(1, $messages);
        $this->assertSame(['customer', 'Do you have size L?', null], [$messages[0]['kind'], $messages[0]['body'], $messages[0]['author']]);

        $this->api($h, 'POST', $this->iUrl($store, "/conversations/{$id}/read"), ['last_read_message_id' => $messages[0]['id']])->assertNoContent();
        $this->api($h, 'GET', $this->iUrl($store, '/summary'))->assertJsonPath('data.unread', 0);
        $this->api($h, 'GET', $this->iUrl($store, '/conversations'))->assertJsonPath('data.0.unread_count', 0);
        // Unread is per member: a staff member still sees it unread.
        [, $hs] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $this->api($hs, 'GET', $this->iUrl($store, '/summary'))->assertJsonPath('data.unread', 1);
    }

    public function test_etag_304_and_invalidation_after_writes(): void
    {
        [, $tenant, $store, $h] = $this->inboxShop();
        [, $id] = $this->verifiedChat($tenant, $store);
        foreach (['/summary', '/conversations', "/conversations/{$id}/messages"] as $path) {
            $etag = $this->api($h, 'GET', $this->iUrl($store, $path))->assertOk()->headers->get('ETag');
            $this->assertStringStartsWith('W/"ix', (string) $etag);
            $this->api($h + ['If-None-Match' => $etag], 'GET', $this->iUrl($store, $path))->assertStatus(304);
            $this->reply($h, $store, $id, 'Reply for '.$path)->assertCreated();
            $this->api($h + ['If-None-Match' => $etag], 'GET', $this->iUrl($store, $path))->assertOk();
        }
    }

    public function test_reply_note_idempotency_dispatch_and_first_response(): void
    {
        Bus::fake([SendInboxReplySms::class]);
        [$owner, $tenant, $store, $h] = $this->inboxShop();
        [, $id] = $this->verifiedChat($tenant, $store);
        $client = (string) Str::uuid();

        $r = $this->reply($h, $store, $id, 'Yes!', ['client_id' => $client])->assertCreated();
        $r->assertJsonPath('data.kind', 'reply')->assertJsonPath('data.author.id', $owner->id)->assertJsonPath('data.sms_status', 'pending')
            ->assertJsonPath('data.delivery_status', null)->assertJsonPath('data.seen', false);
        $this->reply($h, $store, $id, 'Yes!', ['client_id' => $client])->assertOk()->assertJsonPath('data.id', $r->json('data.id'));
        Bus::assertDispatchedTimes(SendInboxReplySms::class, 1);

        $this->reply($h, $store, $id, 'Staff only', ['kind' => 'note'])->assertCreated()->assertJsonPath('data.kind', 'note')->assertJsonPath('data.sms_status', null);
        Bus::assertDispatchedTimes(SendInboxReplySms::class, 1);
        $this->assertNotNull($this->conversationRow($tenant, $id)->first_response_at);
        $this->api($h, 'GET', $this->iUrl($store, '/conversations'))->assertJsonPath('data.0.preview', 'Yes!'); // notes never in preview

        // Validation: empty body without attachments, bad kind, missing client_id, >3 attachments.
        $this->reply($h, $store, $id, '   ')->assertUnprocessable()->assertJsonPath('error.code', 'validation_failed');
        $this->reply($h, $store, $id, 'x', ['kind' => 'system'])->assertUnprocessable();
        $this->api($h, 'POST', $this->iUrl($store, "/conversations/{$id}/messages"), ['kind' => 'reply', 'body' => 'x'])->assertUnprocessable();
        $this->reply($h, $store, $id, 'x', ['attachment_ids' => array_map(fn () => strtolower((string) Str::ulid()), range(1, 4))])->assertUnprocessable();
        $this->reply($h, $store, $id, 'x', ['attachment_ids' => [strtolower((string) Str::ulid())]])->assertUnprocessable()
            ->assertJsonValidationErrors(['attachment_ids'], 'error.details');
        $this->reply($h, $store, $id, str_repeat('a', 4001))->assertUnprocessable();
    }

    public function test_attachments_on_a_reply_only_own_unattached_uploads(): void
    {
        Bus::fake([SendInboxReplySms::class]);
        [, $tenant, $store, $h] = $this->inboxShop();
        [, $id] = $this->verifiedChat($tenant, $store);
        $pdf = $this->inboxUpload($h, $store, 'bill.pdf', self::pdf())->assertCreated()->json('data.id');
        [, $hs] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $this->reply($hs, $store, $id, 'not yours', ['attachment_ids' => [$pdf]])->assertUnprocessable();

        $r = $this->reply($h, $store, $id, '', ['attachment_ids' => [$pdf]])->assertCreated();
        $r->assertJsonPath('data.attachments.0.id', $pdf)->assertJsonPath('data.attachments.0.kind', 'pdf')->assertJsonPath('data.body', '');
        $this->assertSame($r->json('data.id'), $this->platformQuery(InboxAttachment::class)->whereKey($pdf)->value('message_id'));
        $this->reply($h, $store, $id, 'again', ['attachment_ids' => [$pdf]])->assertUnprocessable(); // already attached
    }

    public function test_status_assign_block_order_and_reopen_rules(): void
    {
        [$owner, $tenant, $store, $h] = $this->inboxShop();
        [$token, $id] = $this->verifiedChat($tenant, $store);
        [$staff, $hs] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $base = $this->iUrl($store, "/conversations/{$id}");

        // Assign → system row + email to the new assignee (not on self-assign).
        $this->api($h, 'POST', "{$base}/assign", ['assignee_id' => $staff->id, 'revision' => 2])->assertOk()
            ->assertJsonPath('data.assignee.id', $staff->id)->assertJsonPath('data.revision', 3);
        Mail::assertQueued(InboxAssignedMail::class, fn (InboxAssignedMail $m) => $m->hasTo($staff->email) && $m->preview === 'Is this in stock?');
        $this->api($h, 'POST', "{$base}/assign", ['assignee_id' => $staff->id, 'revision' => 2])->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');
        $this->api($hs, 'POST', "{$base}/assign", ['assignee_id' => $staff->id])->assertOk(); // same → no-op
        Mail::assertQueuedCount(1);
        // Custom role without inbox.manage can't be assigned.
        $this->planFor($tenant, 'growth');
        $role = $this->customRole($h, 'Packer', ['shipments.manage']);
        [$packer] = $this->memberWithRole($tenant, $role);
        $this->api($h, 'POST', "{$base}/assign", ['assignee_id' => $packer->id])->assertUnprocessable()->assertJsonPath('error.code', 'inbox_assignee_invalid');

        // Staff sees it in "mine"; owner's default scope still sees unassigned only.
        $this->api($hs, 'GET', $this->iUrl($store, '/conversations?filter[scope]=mine'))->assertJsonCount(1, 'data');
        $this->api($h, 'GET', $this->iUrl($store, '/conversations'))->assertJsonCount(0, 'data');
        $this->api($h, 'GET', $this->iUrl($store, '/conversations?filter[scope]=all'))->assertJsonCount(1, 'data');

        // Close → shopper writes → reopened and still assigned (P88E-5).
        $this->api($h, 'POST', "{$base}/status", ['status' => 'closed'])->assertOk()->assertJsonPath('data.status', 'closed')->assertJsonPath('data.closed_by.id', $owner->id);
        $this->api($h, 'POST', "{$base}/status", ['status' => 'closed'])->assertOk();
        $this->chat($store, $token, 'POST', '/messages', ['body' => 'Hello again?', 'client_id' => (string) Str::uuid()])->assertCreated();
        $row = $this->conversationRow($tenant, $id);
        $this->assertSame(['open', $staff->id], [$row->status, $row->assignee_id]);
        $events = array_values(array_filter(array_map(fn (InboxMessage $m) => $m->system_event, $this->messagesOf($tenant, $id))));
        $this->assertSame(['assigned', 'closed', 'reopened'], $events);

        // Pending; a member reply on a closed conversation reopens it.
        $this->api($h, 'POST', "{$base}/status", ['status' => 'pending'])->assertOk()->assertJsonPath('data.status', 'pending');
        $this->api($h, 'POST', "{$base}/status", ['status' => 'closed'])->assertOk();
        $this->reply($h, $store, $id, 'Back to you')->assertCreated();
        $this->assertSame('open', $this->conversationRow($tenant, $id)->status);
        $this->api($h, 'POST', "{$base}/status", ['status' => 'archived'])->assertUnprocessable();

        // Order link (orders.view), another store's order → 404.
        [$orderId, $number] = $this->sfOrder($h, $store);
        $this->api($h, 'PUT', "{$base}/order", ['order_id' => $orderId])->assertOk()->assertJsonPath('data.order.number', $number)
            ->assertJsonPath('data.customer.linked_order.number', $number);
        [, , $storeB, $hB] = $this->liveShop('other');
        [$otherOrder] = $this->sfOrder($hB, $storeB);
        $this->api($h, 'PUT', "{$base}/order", ['order_id' => $otherOrder])->assertNotFound();
        $this->api($h, 'PUT', "{$base}/order", ['order_id' => null])->assertOk()->assertJsonPath('data.order', null);

        // Block: shopper messages are swallowed (201 to the shopper, nothing stored).
        $this->api($h, 'POST', "{$base}/block")->assertOk()->assertJsonPath('data.blocked', true);
        $count = count($this->messagesOf($tenant, $id));
        $this->chat($store, $token, 'POST', '/messages', ['body' => 'spam', 'client_id' => (string) Str::uuid()])->assertCreated()->assertJsonPath('data.body', 'spam');
        $this->assertCount($count, $this->messagesOf($tenant, $id));
        $this->api($h, 'GET', $this->iUrl($store, '/summary'))->assertJsonPath('data.open', 0);
        $this->api($h, 'POST', "{$base}/unblock")->assertOk()->assertJsonPath('data.blocked', false);
        $this->assertSame(['inbox_conversation.assigned', 'inbox_conversation.blocked', 'inbox_conversation.unblocked'],
            array_column($this->auditRows($tenant, 'inbox_conversation.'), 'action'));
    }

    public function test_read_never_moves_backwards_and_rejects_foreign_messages(): void
    {
        [$owner, $tenant, $store, $h] = $this->inboxShop();
        [$token, $id] = $this->verifiedChat($tenant, $store);
        $this->chat($store, $token, 'POST', '/messages', ['body' => 'second', 'client_id' => (string) Str::uuid()])->assertCreated();
        [$first, $second] = array_map(fn (InboxMessage $m) => $m->id, $this->messagesOf($tenant, $id));
        $url = $this->iUrl($store, "/conversations/{$id}/read");
        $this->api($h, 'POST', $url, ['last_read_message_id' => $second])->assertNoContent();
        $this->api($h, 'POST', $url, ['last_read_message_id' => $first])->assertNoContent();
        $this->assertSame($second, $this->platformQuery(InboxRead::class)->where('tenant_id', $tenant->id)->value('last_read_message_id'));
        $this->api($h, 'POST', $url, ['last_read_message_id' => strtolower((string) Str::ulid())])->assertUnprocessable();
    }

    public function test_delete_needs_customers_delete_and_removes_files(): void
    {
        [, $tenant, $store, $h] = $this->inboxShop();
        $png = $this->pngFile();
        $token = $this->startChat($store, [], $png)->assertCreated()->json('data.session_token');
        $this->chat($store, $token, 'POST', '/sessions/verify', ['code' => $this->sms()->lastCodeFor(self::MSISDN)])->assertOk();
        $id = $this->conversationOf($tenant, 'web_chat')->id;
        $media = $this->platformQuery(InboxAttachment::class)->where('tenant_id', $tenant->id)->value('media_id');
        $this->assertNotNull($media);

        [, $hs] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $this->api($hs, 'DELETE', $this->iUrl($store, "/conversations/{$id}"))->assertForbidden();
        $this->api($h, 'DELETE', $this->iUrl($store, "/conversations/{$id}"))->assertNoContent();
        $this->assertNull($this->conversationRow($tenant, $id));
        $this->assertSame(0, $this->platformTable('media')->where('id', $media)->count());
        $this->assertSame([], self::storageDisk()->allFiles("tenants/{$tenant->id}/media/{$media}"));
        $audit = $this->auditRows($tenant, 'inbox_conversation.deleted')[0];
        $this->assertSame('017••••0222', $audit['meta']['contact']);
        $this->assertArrayNotHasKey('body', $audit['meta']);
    }

    public function test_assignees_list_you_first_and_departed_member_is_unassigned(): void
    {
        [$owner, $tenant, $store, $h] = $this->inboxShop();
        [, $id] = $this->verifiedChat($tenant, $store);
        [$staff] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $this->api($h, 'POST', $this->iUrl($store, "/conversations/{$id}/assign"), ['assignee_id' => $staff->id])->assertOk();

        $rows = $this->api($h, 'GET', $this->iUrl($store, '/assignees'))->assertOk()->json('data');
        $this->assertSame([$owner->id, true, 'Owner'], [$rows[0]['user']['id'], $rows[0]['is_you'], $rows[0]['role_name']]);
        $this->assertSame([$staff->id, 1, 'Staff'], [$rows[1]['user']['id'], $rows[1]['open_count'], $rows[1]['role_name']]);

        $this->api($h, 'DELETE', "/api/v1/staff/{$this->membershipOf($staff, $tenant)->id}")->assertSuccessful();
        $row = $this->conversationRow($tenant, $id);
        $this->assertNull($row->assignee_id);
        $this->assertSame('unassigned', collect($this->messagesOf($tenant, $id))->last()->system_event);
    }

    public function test_search_and_filters(): void
    {
        [, $tenant, $store, $h] = $this->inboxShop();
        $this->verifiedChat($tenant, $store, 'first', '01711000333');
        $this->verifiedChat($tenant, $store, 'second', '01811000444');
        $url = fn (string $q) => $this->iUrl($store, '/conversations?'.$q);
        $this->api($h, 'GET', $url('q=0181100'))->assertJsonCount(1, 'data')->assertJsonPath('data.0.preview', 'second');
        $this->api($h, 'GET', $url('q=01711000333'))->assertJsonCount(1, 'data')->assertJsonPath('data.0.preview', 'first');
        $this->api($h, 'GET', $url('q=raf'))->assertJsonCount(2, 'data');
        $this->api($h, 'GET', $url('q=%25%25'))->assertJsonCount(0, 'data'); // % literal
        $this->api($h, 'GET', $url('filter[channel]=email'))->assertJsonCount(0, 'data');
        $this->api($h, 'GET', $url('filter[channel]=email,web_chat'))->assertJsonCount(2, 'data');
        $this->api($h, 'GET', $url('filter[status]=closed'))->assertJsonCount(0, 'data')->assertJsonPath('meta.counts.open', 2);
        $this->api($h, 'GET', $url('filter[channel]=sms'))->assertUnprocessable();
    }

    public function test_tenant_and_store_isolation(): void
    {
        [, $tenantA, $storeA, $hA] = $this->inboxShop('alpha');
        [, $tenantB, $storeB, $hB] = $this->inboxShop('beta');
        [, $idB] = $this->verifiedChat($tenantB, $storeB);
        $this->verifiedChat($tenantA, $storeA, 'mine', '01911000555');

        foreach (['GET' => ['', '/messages'], 'POST' => ['/assign', '/status', '/block', '/unblock', '/read', '/messages'], 'DELETE' => ['']] as $method => $paths) {
            foreach ($paths as $p) {
                $this->api($hA, $method, $this->iUrl($storeA, "/conversations/{$idB}{$p}"), ['status' => 'closed', 'assignee_id' => null,
                    'last_read_message_id' => strtolower((string) Str::ulid()), 'kind' => 'note', 'body' => 'x', 'client_id' => (string) Str::uuid()])->assertNotFound();
            }
        }
        // Another tenant's store id → 404.
        $this->api($hA, 'GET', $this->iUrl($storeB, '/conversations'))->assertNotFound();
        $this->assertStoreIsolation(InboxConversation::class, $tenantA, $storeA, $storeB);
        $this->assertStoreIsolation(InboxMessage::class, $tenantA, $storeA, $storeB);
        $this->assertSame(1, $this->platformQuery(InboxMessage::class)->where('conversation_id', $idB)->count());
    }

    public function test_permissions_and_impersonation(): void
    {
        [, $tenant, $store, $h] = $this->inboxShop();
        [, $id] = $this->verifiedChat($tenant, $store);
        $this->planFor($tenant, 'growth');
        [, $hc] = $this->memberWithRole($tenant, $this->customRole($h, 'Viewer', ['orders.view']));
        foreach (['/summary', '/conversations', "/conversations/{$id}", '/assignees', '/saved-replies'] as $path) {
            $this->api($hc, 'GET', $this->iUrl($store, $path))->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        }
        [, $hi] = $this->memberWithRole($tenant, $this->customRole($h, 'Support', ['inbox.manage']));
        $this->api($hi, 'GET', $this->iUrl($store, "/conversations/{$id}"))->assertOk()->assertJsonPath('data.customer.customer', null)
            ->assertJsonPath('data.customer.past_orders', [])->assertJsonPath('data.can.link_order', false)->assertJsonPath('data.can.delete', false);
        $this->api($hi, 'PUT', $this->iUrl($store, "/conversations/{$id}/order"), ['order_id' => null])->assertForbidden();
        $this->api($hi, 'GET', $this->iUrl($store, '/settings'))->assertOk()->assertJsonPath('data.can.edit', false);
        $this->api($hi, 'PATCH', $this->iUrl($store, '/settings'), ['revision' => 2, 'web_chat_enabled' => false])->assertForbidden();
    }
}
