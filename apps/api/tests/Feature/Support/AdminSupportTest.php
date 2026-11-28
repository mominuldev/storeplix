<?php

declare(strict_types=1);

namespace Tests\Feature\Support;

use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Identity\Models\User;
use App\Domain\Media\Models\Media;
use App\Domain\Support\Jobs\SendCoalescedSupportReply;
use App\Domain\Support\Mail\SupportTicketAssignedMail;
use App\Domain\Support\Mail\SupportTicketReceivedMail;
use App\Domain\Support\Mail\SupportTicketRepliedMail;
use App\Domain\Support\Mail\SupportTicketResolvedMail;
use App\Domain\Support\Mail\SupportTicketStaffMail;
use App\Domain\Support\Models\SupportTicket;
use App\Domain\Support\Models\SupportTicketAttachment;
use App\Domain\Support\Models\SupportTicketMessage;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CommerceFixtures;
use Tests\Support\HelpFixtures;
use Tests\Support\PlatformStaffFixtures;
use Tests\TestCase;

/** PHASE-8-9C §9–§10 support queue (cross-tenant), staff actions, order card, mails, commands, platform authz. */
#[Group('support')]
class AdminSupportTest extends TestCase
{
    use CommerceFixtures, HelpFixtures, PlatformStaffFixtures, RefreshDatabase {
        HelpFixtures::assertTenantIsolation insteadof CommerceFixtures;
    }

    private User $staff;

    protected function setUp(): void
    {
        parent::setUp();
        config(['admin.ip_allowlist' => [], 'admin.email_domains' => [], 'support.team_email' => 'team@storeplix.test']);
        Storage::fake('local');
        Storage::fake('public');
        Mail::fake();
        $this->withoutMiddleware(ThrottleRequests::class);
        $this->staff = $this->staffUser(PlatformRole::Support, ['name' => 'Rumana Akter']);
    }

    private function admin(string $method, string $uri, array $body = [], ?User $as = null): TestResponse
    {
        $this->asAdminSurface();

        return $this->flushHeaders()->withHeaders($this->adminHeaders($as ?? $this->staff))->json($method, '/api/v1/admin/support'.$uri, $body);
    }

    private function send(string $id, string $kind, string $body, array $extra = [], ?User $as = null): TestResponse
    {
        return $this->admin('POST', "/tickets/{$id}/messages", $extra + ['kind' => $kind, 'body' => $body, 'client_id' => (string) Str::uuid()], $as);
    }

    public function test_queue_lists_tickets_across_tenants_with_filters_sorts_counts_and_stats(): void
    {
        [$ownerA, $tenantA] = $this->liveShop('alpha');
        [$ownerB, $tenantB] = $this->liveShop('bravo');
        $a = $this->helpTicket($tenantA, $ownerA, ['subject' => 'Courier stuck', 'priority' => 'high']);
        $this->travel(1)->minutes();
        $b = $this->helpTicket($tenantB, $ownerB, ['subject' => 'Domain broken', 'category' => 'storefront_domain', 'priority' => 'urgent']);
        $this->send($b->id, 'reply', 'Looking')->assertCreated();

        $res = $this->admin('GET', '/tickets')->assertOk();
        $this->assertSame([$a->id], array_column($res->json('data'), 'id')); // default open + awaiting_support
        $res->assertJsonPath('data.0.shop.tenant_id', $tenantA->id)->assertJsonPath('data.0.reference', $a->reference())
            ->assertJsonPath('meta.counts.open', 1)->assertJsonPath('meta.counts.awaiting_merchant', 1)->assertJsonPath('meta.counts.unassigned', 2);
        $this->assertNotNull($res->json('meta.stats.median_first_reply_seconds_7d'));

        $all = $this->admin('GET', '/tickets?filter[status]=open,awaiting_merchant&sort=priority')->assertOk();
        $this->assertSame([$b->id, $a->id], array_column($all->json('data'), 'id'));
        $this->assertSame([$b->id], array_column($this->admin('GET', '/tickets?filter[status]=awaiting_merchant&filter[category]=storefront_domain')->json('data'), 'id'));
        $this->assertSame([$a->id], array_column($this->admin('GET', '/tickets?filter[status]=open,awaiting_merchant&filter[q]=T-'.$a->number)->json('data'), 'id'));
        $this->assertSame([$b->id], array_column($this->admin('GET', '/tickets?filter[status]=open,awaiting_merchant&filter[q]=bravo')->json('data'), 'id'));
        $this->assertSame([$a->id], array_column($this->admin('GET', '/tickets?filter[status]=open,awaiting_merchant&filter[q]='.urlencode($ownerA->email))->json('data'), 'id'));
        $this->assertSame([$a->id], array_column($this->admin('GET', '/tickets?filter[status]=open,awaiting_merchant&filter[priority]=high')->json('data'), 'id'));
        $this->admin('GET', '/tickets?filter[status]=bogus')->assertStatus(422);

        $this->admin('POST', "/tickets/{$a->id}/assign", ['assignee_id' => $this->staff->id])->assertOk()->assertJsonPath('data.assignee.id', $this->staff->id);
        $this->assertSame([$a->id], array_column($this->admin('GET', '/tickets?filter[assignee]=me')->json('data'), 'id'));
        $this->assertSame([], $this->admin('GET', '/tickets?filter[assignee]=unassigned')->json('data'));
        $this->assertSame(1, $this->admin('GET', '/tickets')->json('meta.counts.mine'));
    }

    public function test_thread_shows_notes_to_staff_and_reply_moves_status_and_emails_the_requester(): void
    {
        [$owner, $tenant] = $this->liveShop();
        $t = $this->helpTicket($tenant, $owner);
        Mail::assertQueued(SupportTicketReceivedMail::class, fn ($m) => $m->hasTo($owner->email));
        Mail::assertQueued(SupportTicketStaffMail::class, fn ($m) => $m->hasTo('team@storeplix.test'));

        $this->send($t->id, 'note', 'Internal: check gateway logs')->assertCreated()->assertJsonPath('data.kind', 'note')
            ->assertJsonPath('data.author.platform_role', 'support');
        $this->assertSame('open', $this->admin('GET', "/tickets/{$t->id}")->json('data.status'));
        Mail::assertNotQueued(SupportTicketRepliedMail::class);
        $this->send($t->id, 'note', 'x', ['status' => 'resolved'])->assertStatus(422);

        $this->send($t->id, 'reply', 'We fixed it')->assertCreated()->assertJsonPath('data.kind', 'staff');
        $detail = $this->admin('GET', "/tickets/{$t->id}")->assertOk();
        $detail->assertJsonPath('data.status', 'awaiting_merchant')->assertJsonPath('data.waiting_since', null)->assertJsonPath('data.requester_email', $owner->email);
        $this->assertNotNull($detail->json('data.first_staff_reply_at'));
        Mail::assertQueued(SupportTicketRepliedMail::class, fn ($m) => $m->hasTo($owner->email) && $m->preview === 'We fixed it' && ! str_contains(serialize($m), 'Internal'));
        $this->assertSame(['system', 'merchant', 'note', 'staff'], array_column($this->admin('GET', "/tickets/{$t->id}/messages")->json('data'), 'kind'));

        $this->send($t->id, 'reply', 'Solved now', ['status' => 'resolved'])->assertCreated();
        $this->assertSame('resolved', $this->admin('GET', "/tickets/{$t->id}")->json('data.status'));
        Mail::assertQueued(SupportTicketResolvedMail::class, fn ($m) => $m->hasTo($owner->email));
        $client = (string) Str::uuid();
        $first = $this->send($t->id, 'note', 'Same', ['client_id' => $client])->json('data.id');
        $this->send($t->id, 'note', 'Same', ['client_id' => $client])->assertOk()->assertJsonPath('data.id', $first);
    }

    public function test_reply_mails_are_coalesced_per_ticket_window_and_fall_back_to_the_owner(): void
    {
        [$owner, $tenant] = $this->liveShop();
        [$admin] = $this->member($tenant, TenantUser::ROLE_ADMIN);
        $t = $this->helpTicket($tenant, $admin);
        Queue::fake([SendCoalescedSupportReply::class]);
        $this->send($t->id, 'reply', 'One')->assertCreated();
        $this->send($t->id, 'reply', 'Two')->assertCreated();
        $this->send($t->id, 'reply', 'Three')->assertCreated();
        // the first is mailed now; later replies in the window are summed into ONE delayed job
        $this->assertCount(1, Mail::queued(SupportTicketRepliedMail::class));
        Mail::assertQueued(SupportTicketRepliedMail::class, fn ($m) => $m->count === 1 && $m->hasTo($admin->email));
        Queue::assertPushed(SendCoalescedSupportReply::class, 1);
        (new SendCoalescedSupportReply($t->id))->handle();
        Mail::assertQueued(SupportTicketRepliedMail::class, fn ($m) => $m->count === 2 && $m->preview === 'Three');

        // requester lost support.manage (became staff) → the owner gets the mail
        $this->inTenant($tenant, fn () => TenantUser::query()->where('user_id', $admin->id)->update(['role' => 'staff', 'role_id' => $this->platformTable('roles')->where('tenant_id', $tenant->id)->where('key', 'staff')->value('id')]));
        $this->send($t->id, 'reply', 'Fixed', ['status' => 'resolved'])->assertCreated();
        Mail::assertQueued(SupportTicketResolvedMail::class, fn ($m) => $m->hasTo($owner->email) && ! $m->hasTo($admin->email));
    }

    public function test_no_staff_mail_without_assignee_and_team_address(): void
    {
        config(['support.team_email' => null]);
        [$owner, $tenant, , $h] = $this->liveShop();
        $this->helpTicket($tenant, $owner);
        Mail::assertNotQueued(SupportTicketStaffMail::class);
    }

    public function test_assign_rules_mail_and_staff_losing_permission_is_unassigned(): void
    {
        [$owner, $tenant, , $h] = $this->liveShop();
        $t = $this->helpTicket($tenant, $owner);
        $billing = $this->staffUser(PlatformRole::Billing, ['name' => 'Karim Billing']);
        $readOnly = $this->staffUser(PlatformRole::ReadOnly);
        $disabled = $this->staffUser(PlatformRole::Support, ['platform_disabled_at' => now()]);
        foreach ([$readOnly->id, $disabled->id, $owner->id, 'nonsense'] as $id) {
            $this->admin('POST', "/tickets/{$t->id}/assign", ['assignee_id' => $id])->assertStatus(422)->assertJsonPath('error.code', 'support_assignee_invalid');
        }
        $this->admin('POST', "/tickets/{$t->id}/assign", ['assignee_id' => $this->staff->id])->assertOk();
        Mail::assertNotQueued(SupportTicketAssignedMail::class); // self-assign
        $res = $this->admin('POST', "/tickets/{$t->id}/assign", ['assignee_id' => $billing->id])->assertOk();
        Mail::assertQueued(SupportTicketAssignedMail::class, fn ($m) => $m->hasTo($billing->email));
        $this->admin('POST', "/tickets/{$t->id}/assign", ['assignee_id' => null, 'revision' => 1])->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');
        $this->assertTrue($this->platformQuery(AuditLog::class)->where('action', 'support_ticket.assigned')->where('tenant_id', $tenant->id)->exists());

        $assigned = collect($this->admin('GET', "/tickets/{$t->id}/messages")->json('data'))->where('system.event', 'assigned')->last();
        $this->assertSame('Karim', $assigned['system']['meta']['assignee_name']);
        $this->assertSame('Rumana', $assigned['system']['meta']['actor_name']);
        $this->flushHeaders()->withHeaders($h)->getJson("/api/v1/help/tickets/{$t->id}/messages")->assertOk();

        $assignees = $this->admin('GET', '/assignees')->assertOk()->json('data');
        $this->assertSame($this->staff->id, $assignees[0]['user']['id']);
        $this->assertTrue($assignees[0]['is_you']);
        $this->assertNotContains($readOnly->id, array_column(array_column($assignees, 'user'), 'id'));
        $this->assertSame(1, collect($assignees)->firstWhere('user.id', $billing->id)['open_count']);

        $billing->forceFill(['platform_disabled_at' => now()])->save();
        $this->assertNull($this->platformQuery(SupportTicket::class)->whereKey($t->id)->value('assignee_id'));
        $this->assertTrue($this->platformQuery(SupportTicketMessage::class)->where('ticket_id', $t->id)->where('system_event', 'unassigned')->exists());
    }

    public function test_status_transitions_priority_and_category(): void
    {
        [$owner, $tenant] = $this->liveShop();
        $t = $this->helpTicket($tenant, $owner);
        $this->admin('POST', "/tickets/{$t->id}/status", ['status' => 'open'])->assertOk(); // same status = no-op
        $this->admin('POST', "/tickets/{$t->id}/status", ['status' => 'awaiting_support'])->assertOk()->assertJsonPath('data.status', 'awaiting_support');
        $this->admin('POST', "/tickets/{$t->id}/status", ['status' => 'open'])->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
        $this->admin('POST', "/tickets/{$t->id}/status", ['status' => 'awaiting_support'])->assertOk();
        $this->admin('POST', "/tickets/{$t->id}/status", ['status' => 'resolved'])->assertOk()->assertJsonPath('data.status', 'resolved');
        Mail::assertQueued(SupportTicketResolvedMail::class);
        $this->admin('POST', "/tickets/{$t->id}/status", ['status' => 'closed'])->assertOk()->assertJsonPath('data.can.reply', false);
        $this->admin('POST', "/tickets/{$t->id}/status", ['status' => 'awaiting_support'])->assertStatus(409);
        $this->send($t->id, 'reply', 'late')->assertStatus(409)->assertJsonPath('error.code', 'support_ticket_closed');
        $this->assertSame(3, $this->platformQuery(AuditLog::class)->where('action', 'support_ticket.status_changed')->count());

        $u = $this->helpTicket($tenant, $owner);
        $rev = $this->admin('GET', "/tickets/{$u->id}")->json('data.revision');
        $this->admin('PATCH', "/tickets/{$u->id}", ['priority' => 'low', 'category' => 'bug', 'revision' => $rev])->assertOk()
            ->assertJsonPath('data.priority', 'low')->assertJsonPath('data.category', 'bug');
        $this->admin('PATCH', "/tickets/{$u->id}", ['priority' => 'high', 'revision' => $rev])->assertStatus(409);
        $this->admin('PATCH', "/tickets/{$u->id}", ['priority' => 'urgent'])->assertStatus(422);
        $events = array_column(array_filter(array_column($this->admin('GET', "/tickets/{$u->id}/messages")->json('data'), 'system')), 'event');
        $this->assertContains('priority_changed', $events);
        $this->assertContains('category_changed', $events);
    }

    public function test_order_card_is_limited_audited_once_a_day_and_hidden_when_closed(): void
    {
        [$owner, $tenant, $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store);
        $order = $this->manual($h, $store, $this->manualBody($variant, 2, ['contact' => ['name' => 'Nusrat Jahan', 'phone' => '01811223344', 'email' => 'n@example.test']]))->assertCreated()->json('data');
        $t = $this->helpTicket($tenant, $owner, ['order_id' => $order['id']]);
        $this->assertSame($order['number'], $t->order_number);

        $card = $this->admin('GET', "/tickets/{$t->id}")->assertOk()->json('data.order_card');
        $this->assertSame(['id', 'number', 'placed_at', 'status', 'payment_status', 'payment_method', 'total_amount', 'paid_amount', 'due_amount', 'currency',
            'items_count', 'first_item_name', 'courier', 'customer'], array_keys($card));
        $this->assertSame(['first_name' => 'Nusrat', 'district' => $card['customer']['district']], $card['customer']);
        $this->assertSame(2, $card['items_count']);
        $raw = $this->admin('GET', "/tickets/{$t->id}")->getContent();
        $this->assertStringNotContainsString('01811223344', $raw);
        $this->assertStringNotContainsString('n@example.test', $raw);
        $this->assertStringNotContainsString('Holding 4', $raw);
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('action', 'support_ticket.order_viewed')->where('tenant_id', $tenant->id)->count());
        $this->travel(1)->days();
        $this->admin('GET', "/tickets/{$t->id}")->assertOk();
        $this->assertSame(2, $this->platformQuery(AuditLog::class)->where('action', 'support_ticket.order_viewed')->count());

        $this->admin('POST', "/tickets/{$t->id}/status", ['status' => 'closed'])->assertOk()->assertJsonPath('data.order_card', null)
            ->assertJsonPath('data.related_order.number', $order['number']);
    }

    public function test_staff_attachments_land_in_the_ticket_tenant_and_stream_only_for_that_ticket(): void
    {
        [$owner, $tenant, , $h] = $this->liveShop();
        $t = $this->helpTicket($tenant, $owner);
        $other = $this->helpTicket($tenant, $owner);
        $file = $this->supportUpload($this->adminHeaders($this->staff) + [], 'fix.png', $this->imageBytes(300, 200), "/api/v1/admin/support/tickets/{$t->id}/attachments");
        if ($file->status() === 403) {
            $this->asAdminSurface();
            $file = $this->supportUpload($this->adminHeaders($this->staff), 'fix.png', $this->imageBytes(300, 200), "/api/v1/admin/support/tickets/{$t->id}/attachments");
        }
        $id = $file->assertCreated()->json('data.id');
        $media = $this->platformQuery(Media::class)->whereKey($this->platformQuery(SupportTicketAttachment::class)->whereKey($id)->value('media_id'))->first();
        $this->assertStringStartsWith("tenants/{$tenant->id}/media/", $media->path);
        $this->assertSame($tenant->id, $media->tenant_id);

        // another ticket can't claim it; this one can
        $this->send($other->id, 'reply', 'x', ['attachment_ids' => [$id]])->assertStatus(422);
        $this->send($t->id, 'reply', 'See screenshot', ['attachment_ids' => [$id]])->assertCreated()->assertJsonPath('data.attachments.0.id', $id);
        $this->asAdminSurface();
        $res = $this->flushHeaders()->withHeaders($this->adminHeaders($this->staff))->get("/api/v1/admin/support/tickets/{$t->id}/attachments/{$id}")->assertOk();
        $res->assertHeader('X-Content-Type-Options', 'nosniff')->assertHeader('Content-Security-Policy', "sandbox; default-src 'none'");
        $this->admin('GET', "/tickets/{$other->id}/attachments/{$id}")->assertNotFound();
        $this->flushHeaders()->withHeaders($h)->getJson("/api/v1/help/attachments/{$id}/link")->assertOk(); // staff reply file is visible to members
    }

    public function test_platform_permissions_and_merchant_sessions(): void
    {
        [$owner, $tenant, , $h] = $this->liveShop();
        $t = $this->helpTicket($tenant, $owner);
        $this->admin('GET', '/tickets', [], $this->staffUser(PlatformRole::ReadOnly))->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        $this->send($t->id, 'reply', 'x', [], $this->staffUser(PlatformRole::ReadOnly))->assertForbidden();
        $this->admin('GET', '/tickets', [], $this->staffUser(PlatformRole::Billing))->assertOk();
        $this->admin('GET', '/tickets', [], $this->staffUser(PlatformRole::SuperAdmin))->assertOk();
        $this->flushHeaders()->withHeaders($h + ['Accept' => 'application/json'])->getJson('/api/v1/admin/support/tickets')->assertForbidden();
        $this->admin('GET', '/tickets/'.strtolower((string) Str::ulid()))->assertNotFound();
    }

    public function test_auto_close_after_seven_days_and_retention_prune(): void
    {
        [$owner, $tenant, , $h] = $this->liveShop();
        $t = $this->helpTicket($tenant, $owner);
        $file = $this->supportUpload($h)->json('data.id');
        $u = $this->flushHeaders()->withHeaders($h)->postJson('/api/v1/help/tickets', self::ticketBody(['attachment_ids' => [$file]]))->assertCreated()->json('data.id');
        $orphan = $this->supportUpload($h)->json('data.id');
        $this->flushHeaders()->withHeaders($h)->postJson("/api/v1/help/tickets/{$t->id}/resolve")->assertOk();
        $this->travel(6)->days();
        $this->artisan('support:close-resolved')->assertSuccessful();
        $this->assertSame('resolved', $this->platformQuery(SupportTicket::class)->whereKey($t->id)->value('status'));
        $this->travel(2)->days();
        $this->artisan('support:close-resolved')->assertSuccessful();
        $this->assertSame('closed', $this->platformQuery(SupportTicket::class)->whereKey($t->id)->value('status'));
        $this->assertTrue($this->platformQuery(SupportTicketMessage::class)->where('ticket_id', $t->id)->where('system_event', 'auto_closed')->exists());

        $this->artisan('support:prune')->assertSuccessful();
        $this->assertFalse($this->platformQuery(SupportTicketAttachment::class)->whereKey($orphan)->exists()); // > 24 h unattached
        $this->assertTrue($this->platformQuery(SupportTicketAttachment::class)->whereKey($file)->exists());
        $this->platformQuery(SupportTicket::class)->whereKey($u)->update(['status' => 'closed', 'closed_at' => now()->subMonths(25)]);
        $mediaId = $this->platformQuery(SupportTicketAttachment::class)->whereKey($file)->value('media_id');
        $this->artisan('support:prune')->assertSuccessful();
        $this->assertFalse($this->platformQuery(SupportTicket::class)->whereKey($u)->exists());
        $this->assertFalse($this->platformQuery(Media::class)->whereKey($mediaId)->exists());
        $this->assertTrue($this->platformQuery(SupportTicket::class)->whereKey($t->id)->exists());
    }
}
