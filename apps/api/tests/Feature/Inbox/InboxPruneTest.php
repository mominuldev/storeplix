<?php

declare(strict_types=1);

namespace Tests\Feature\Inbox;

use App\Domain\Inbox\Models\InboxAttachment;
use App\Domain\Inbox\Models\InboxConversation;
use App\Domain\Inbox\Models\InboxMagicLink;
use App\Domain\Inbox\Models\InboxMessage;
use App\Domain\Inbox\Models\InboxWidgetSession;
use App\Domain\Inbox\WidgetService;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Mail;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/** PHASE-8-8E P88E-18 / S247: `inbox:prune` retention. */
#[Group('inbox')]
class InboxPruneTest extends TestCase
{
    use InboxFixtures, RefreshDatabase;

    public function test_retention(): void
    {
        $this->setUpInbox();
        Mail::fake();
        [, $tenant, $store, $h] = $this->inboxShop();
        [$token, $old] = $this->verifiedChat($tenant, $store, 'old', '01711000401');
        $this->reply($h, $store, $old, 'see file', ['attachment_ids' => [$this->inboxUpload($h, $store, 'a.pdf', self::pdf())->json('data.id')]])->assertCreated();
        $this->inTenant($tenant, fn () => app(WidgetService::class)->magicLink(InboxConversation::query()->findOrFail($old)));
        $media = $this->platformQuery(InboxAttachment::class)->where('tenant_id', $tenant->id)->value('media_id');

        $this->travel(25)->months();
        [, $fresh] = $this->verifiedChat($tenant, $store, 'fresh', '01711000402');
        $stale = $this->inboxUpload($h, $store, 'stale.pdf', self::pdf())->json('data.id');
        $this->startChat($store, ['phone' => '01711000403'])->assertCreated(); // a pending session
        $this->travel(2)->days();

        $this->artisan('inbox:prune')->assertSuccessful();
        $this->assertNull($this->conversationRow($tenant, $old));
        $this->assertSame(0, $this->platformQuery(InboxMessage::class)->where('conversation_id', $old)->count());
        $this->assertSame(0, $this->platformTable('media')->where('id', $media)->count());
        $this->assertSame(0, $this->platformQuery(InboxMagicLink::class)->count());
        $this->assertNotNull($this->conversationRow($tenant, $fresh));
        $this->assertNull($this->platformQuery(InboxAttachment::class)->find($stale));
        $this->assertSame(0, $this->platformQuery(InboxWidgetSession::class)->where('status', 'pending')->count());
        $this->assertSame(1, $this->platformQuery(InboxWidgetSession::class)->where('status', 'verified')->count()); // fresh chat, 90 days
    }
}
