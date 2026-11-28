<?php

declare(strict_types=1);

namespace Tests\Feature\Support;

use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Admin\Impersonation\ImpersonationService;
use App\Domain\Identity\Models\User;
use App\Domain\Media\Models\Media;
use App\Domain\Support\Mail\SupportTicketAssignedMail;
use App\Domain\Support\Mail\SupportTicketReceivedMail;
use App\Domain\Support\Mail\SupportTicketRepliedMail;
use App\Domain\Support\Mail\SupportTicketStaffMail;
use App\Domain\Support\Models\SupportTicket;
use App\Domain\Support\Models\SupportTicketAttachment;
use App\Domain\Support\SupportAttachments;
use App\Domain\Support\SupportTicketService;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CommerceFixtures;
use Tests\Support\HelpFixtures;
use Tests\Support\PlatformStaffFixtures;
use Tests\Support\RoleFixtures;
use Tests\Support\SpaBrowser;
use Tests\TestCase;

/** PHASE-8-9C §8 merchant tickets: create, list, thread, replies, resolve, rating, attachments, authz, isolation, S251. */
#[Group('support')]
class SupportTicketsApiTest extends TestCase
{
    use CommerceFixtures, HelpFixtures, PlatformStaffFixtures, RefreshDatabase, RoleFixtures, SpaBrowser {
        HelpFixtures::assertTenantIsolation insteadof CommerceFixtures;
    }

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('local');
        Storage::fake('public');
        Mail::fake();
        $this->withoutMiddleware(ThrottleRequests::class);
    }

    public function test_owner_creates_a_ticket_with_an_order_and_a_file_and_replays_are_idempotent(): void
    {
        [$owner, $tenant, $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store);
        $order = $this->manual($h, $store, $this->manualBody($variant))->assertCreated()->json('data');
        $file = $this->supportUpload($h)->assertCreated()->assertJsonPath('data.kind', 'pdf')->assertJsonPath('data.status', 'ready')->json('data.id');
        $body = self::ticketBody(['order_id' => $order['id'], 'attachment_ids' => [$file], 'priority' => 'urgent']);

        $res = $this->api($h, 'POST', '/api/v1/help/tickets', $body)->assertCreated();
        $res->assertJsonPath('data.reference', 'T-1001')->assertJsonPath('data.number', 1001)->assertJsonPath('data.status', 'open')
            ->assertJsonPath('data.priority', 'urgent')->assertJsonPath('data.related_order.number', $order['number'])
            ->assertJsonPath('data.order_card.id', $order['id'])->assertJsonPath('data.requester.id', $owner->id)
            ->assertJsonPath('data.files.0.id', $file)->assertJsonPath('data.can', ['reply' => true, 'resolve' => true, 'rate' => false]);
        $id = $res->json('data.id');
        $this->api($h, 'POST', '/api/v1/help/tickets', $body)->assertOk()->assertJsonPath('data.id', $id);
        $this->assertSame(1, $this->inTenant($tenant, fn () => SupportTicket::query()->count()));

        $messages = $this->api($h, 'GET', "/api/v1/help/tickets/{$id}/messages")->assertOk()->json('data');
        $this->assertSame(['system', 'merchant'], array_column($messages, 'kind'));
        $this->assertSame('created', $messages[0]['system']['event']);
        $this->assertSame($file, $messages[1]['attachments'][0]['id']);
        $this->assertTrue($this->platformQuery(AuditLog::class)->where('action', 'support_ticket.created')->where('tenant_id', $tenant->id)->exists());

        $this->api($h, 'POST', '/api/v1/help/tickets', self::ticketBody())->assertCreated()->assertJsonPath('data.number', 1002);
    }

    public function test_validation_and_order_rules(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        $this->api($h, 'POST', '/api/v1/help/tickets', ['client_id' => 'nope'])->assertStatus(422)
            ->assertJsonValidationErrors(['category', 'subject', 'description', 'client_id'], 'error.details');
        $this->api($h, 'POST', '/api/v1/help/tickets', self::ticketBody(['subject' => 'Hey', 'description' => 'too short', 'priority' => 'low']))
            ->assertStatus(422)->assertJsonValidationErrors(['subject', 'description', 'priority'], 'error.details');
        $this->api($h, 'POST', '/api/v1/help/tickets', self::ticketBody(['order_id' => strtolower((string) Str::ulid())]))
            ->assertStatus(422)->assertJsonValidationErrors(['order_id'], 'error.details');

        // order of another tenant → 422; a custom role with support.manage but not orders.view → 422 on order_id
        [, , $storeB, $hB] = $this->liveShop('other');
        [, $variantB] = $this->stocked($hB, $storeB);
        $orderB = $this->manual($hB, $storeB, $this->manualBody($variantB))->assertCreated()->json('data.id');
        $this->api($h, 'POST', '/api/v1/help/tickets', self::ticketBody(['order_id' => $orderB]))->assertStatus(422)->assertJsonValidationErrors(['order_id'], 'error.details');
        [, $variant] = $this->stocked($h, $store);
        $order = $this->manual($h, $store, $this->manualBody($variant))->assertCreated()->json('data.id');
        $this->planFor($tenant, 'growth');
        $role = $this->customRole($h, 'Support only', ['support.manage']);
        [, $mh] = $this->memberWithRole($tenant, $role);
        $this->api($mh, 'POST', '/api/v1/help/tickets', self::ticketBody(['order_id' => $order]))->assertStatus(422)->assertJsonValidationErrors(['order_id'], 'error.details');
        $created = $this->api($mh, 'POST', '/api/v1/help/tickets', self::ticketBody())->assertCreated();
        $created->assertJsonPath('data.order_card', null);

        // attachments: ≤ 5, own unattached uploads only
        $ids = array_map(fn () => $this->supportUpload($h)->json('data.id'), range(1, 6));
        $this->api($h, 'POST', '/api/v1/help/tickets', self::ticketBody(['attachment_ids' => $ids]))->assertStatus(422);
        $this->api($mh, 'POST', '/api/v1/help/tickets', self::ticketBody(['attachment_ids' => [$ids[0]]]))->assertStatus(422)->assertJsonValidationErrors(['attachment_ids'], 'error.details');
    }

    public function test_limit_of_20_not_closed_tickets(): void
    {
        [$owner, $tenant, , $h] = $this->liveShop();
        foreach (range(1, 20) as $i) {
            $this->helpTicket($tenant, $owner);
        }
        $this->api($h, 'POST', '/api/v1/help/tickets', self::ticketBody())->assertStatus(422)->assertJsonPath('error.code', 'support_ticket_limit_reached');
        $this->inTenant($tenant, fn () => SupportTicket::query()->limit(1)->update(['status' => 'closed', 'closed_at' => now()]));
        $this->api($h, 'POST', '/api/v1/help/tickets', self::ticketBody())->assertCreated();
    }

    public function test_create_limiter_is_10_per_hour_per_tenant(): void
    {
        $this->withMiddleware(ThrottleRequests::class);
        [, , , $h] = $this->liveShop();
        foreach (range(1, 10) as $i) {
            $this->api($h, 'POST', '/api/v1/help/tickets', self::ticketBody())->assertCreated();
        }
        $this->api($h, 'POST', '/api/v1/help/tickets', self::ticketBody())->assertStatus(429);
    }

    public function test_list_tabs_counts_search_and_stats(): void
    {
        [$owner, $tenant, , $h] = $this->liveShop();
        $a = $this->helpTicket($tenant, $owner, ['subject' => 'Courier did not pick up']);
        $b = $this->helpTicket($tenant, $owner, ['subject' => 'Domain not working']);
        $c = $this->helpTicket($tenant, $owner, ['subject' => 'Billing question here']);
        $staff = $this->staffUser(PlatformRole::Support);
        $this->travel(5)->seconds();
        $this->inTenant($tenant, function () use ($b, $c, $staff, $owner) {
            $s = app(SupportTicketService::class);
            $s->staffSend($b->id, $staff, ['kind' => 'reply', 'body' => 'Please check DNS', 'client_id' => (string) Str::uuid()]);
            $s->resolveByMerchant($c->id, $owner);
            $s->rate($c->id, $owner, 4, 'Quick');
        });

        $res = $this->api($h, 'GET', '/api/v1/help/tickets')->assertOk();
        $res->assertJsonPath('meta.counts', ['all' => 3, 'open' => 1, 'waiting_on_you' => 1, 'solved' => 1])
            ->assertJsonPath('meta.stats.open', 1)->assertJsonPath('meta.stats.waiting_on_you', 1)->assertJsonPath('meta.stats.solved_this_month', 1)
            ->assertJsonPath('meta.stats.csat_average', 4)->assertJsonPath('meta.stats.csat_count', 1);
        $this->assertNotNull($res->json('meta.stats.avg_first_reply_seconds'));
        $this->assertSame($b->id, $res->json('data.0.id')); // last_message_at desc
        $this->assertSame('Store Plix', explode(' · ', $res->json('data.0.last_reply.author.name'))[1]);
        $this->assertNull($res->json('data.0.last_reply.author.id'));

        $this->assertSame([$b->id], array_column($this->api($h, 'GET', '/api/v1/help/tickets?filter[tab]=waiting_on_you')->json('data'), 'id'));
        $this->assertSame([$a->id], array_column($this->api($h, 'GET', '/api/v1/help/tickets?filter[q]=courier')->json('data'), 'id'));
        $this->assertSame([$a->id], array_column($this->api($h, 'GET', '/api/v1/help/tickets?filter[q]=T-'.$a->number)->json('data'), 'id'));
        $this->assertSame([$a->id], array_column($this->api($h, 'GET', '/api/v1/help/tickets?filter[q]='.$a->number)->json('data'), 'id'));
        $this->api($h, 'GET', '/api/v1/help/tickets?filter[tab]=nope')->assertStatus(422);
    }

    public function test_reply_transitions_reopen_resolve_and_closed_is_final(): void
    {
        [$owner, $tenant, , $h] = $this->liveShop();
        $t = $this->helpTicket($tenant, $owner);
        $staff = $this->staffUser(PlatformRole::Support);
        $url = "/api/v1/help/tickets/{$t->id}";
        $reply = fn (string $body = 'More detail here', ?string $client = null) => $this->api($h, 'POST', "{$url}/messages", ['body' => $body, 'client_id' => $client ?? (string) Str::uuid()]);

        $reply()->assertCreated()->assertJsonPath('data.kind', 'merchant')->assertJsonPath('data.author.id', $owner->id);
        $this->assertSame('open', $this->ticket($tenant, $t->id)->status); // still unanswered
        $this->inTenant($tenant, fn () => app(SupportTicketService::class)->staffSend($t->id, $staff, ['kind' => 'reply', 'body' => 'Hi', 'client_id' => (string) Str::uuid()]));
        $this->assertSame('awaiting_merchant', $this->ticket($tenant, $t->id)->status);
        $client = (string) Str::uuid();
        $first = $reply('Thanks', $client)->assertCreated()->json('data.id');
        $reply('Thanks', $client)->assertOk()->assertJsonPath('data.id', $first);
        $row = $this->ticket($tenant, $t->id);
        $this->assertSame('awaiting_support', $row->status);
        $this->assertNotNull($row->waiting_since);

        $this->api($h, 'POST', "{$url}/resolve")->assertOk()->assertJsonPath('data.status', 'resolved')->assertJsonPath('data.can.rate', true);
        $this->api($h, 'POST', "{$url}/resolve")->assertOk()->assertJsonPath('data.status', 'resolved');
        $reply('Actually it broke again')->assertCreated();
        $row = $this->ticket($tenant, $t->id);
        $this->assertSame(['awaiting_support', 1], [$row->status, $row->reopened_count]);
        $this->assertContains('reopened', array_column(array_column($this->api($h, 'GET', "{$url}/messages")->json('data'), 'system'), 'event'));

        $this->inTenant($tenant, fn () => app(SupportTicketService::class)->setStatus($t->id, $staff, 'closed', null));
        $reply()->assertStatus(409)->assertJsonPath('error.code', 'support_ticket_closed');
        $this->api($h, 'POST', "{$url}/resolve")->assertStatus(409)->assertJsonPath('error.code', 'support_ticket_closed');
        $this->api($h, 'GET', $url)->assertOk()->assertJsonPath('data.can.reply', false);
        $reply('')->assertStatus(422);
        $this->api($h, 'POST', "{$url}/messages", ['body' => str_repeat('x', 5001), 'client_id' => (string) Str::uuid()])->assertStatus(422);
    }

    public function test_rating_window(): void
    {
        [$owner, $tenant, , $h] = $this->liveShop();
        $t = $this->helpTicket($tenant, $owner);
        $url = "/api/v1/help/tickets/{$t->id}/rating";
        $this->api($h, 'PUT', $url, ['rating' => 5])->assertStatus(409)->assertJsonPath('error.code', 'support_rating_unavailable');
        $this->api($h, 'POST', "/api/v1/help/tickets/{$t->id}/resolve")->assertOk();
        $this->api($h, 'PUT', $url, ['rating' => 6])->assertStatus(422);
        $this->api($h, 'PUT', $url, ['rating' => 3, 'comment' => 'ok'])->assertOk()->assertJsonPath('data.rating.rating', 3);
        $this->api($h, 'PUT', $url, ['rating' => 5])->assertOk()->assertJsonPath('data.rating.rating', 5)->assertJsonPath('data.rating.comment', null);
        $this->travel(15)->days();
        $this->api($h, 'PUT', $url, ['rating' => 4])->assertStatus(409)->assertJsonPath('error.code', 'support_rating_unavailable');
        // the `rated` system row is staff-only
        $this->assertNotContains('rated', array_column(array_filter(array_column($this->api($h, 'GET', "/api/v1/help/tickets/{$t->id}/messages")->json('data'), 'system')), 'event'));
    }

    /** S251: notes (and note attachments) never reach any merchant route. */
    public function test_internal_notes_never_leak_to_merchants(): void
    {
        [$owner, $tenant, , $h] = $this->liveShop();
        $t = $this->helpTicket($tenant, $owner);
        $staff = $this->staffUser(PlatformRole::Support);
        $noteFile = $this->inTenant($tenant, function () use ($t, $staff) {
            $s = app(SupportTicketService::class);
            $file = app(SupportAttachments::class)->store(
                UploadedFile::fake()->createWithContent('secret.pdf', self::pdfBytes()), ['mime' => 'application/pdf', 'width' => 0, 'height' => 0], 'staff', $staff->id, $t->id);
            $s->staffSend($t->id, $staff, ['kind' => 'note', 'body' => 'SECRET-NOTE risky merchant', 'attachment_ids' => [$file->id], 'client_id' => (string) Str::uuid()]);
            $s->assign($t->id, $staff, $staff->id, null);

            return $file->id;
        });
        $everything = $this->api($h, 'GET', "/api/v1/help/tickets/{$t->id}")->assertOk()->getContent()
            .$this->api($h, 'GET', "/api/v1/help/tickets/{$t->id}/messages")->assertOk()->getContent()
            .$this->api($h, 'GET', '/api/v1/help/tickets')->assertOk()->getContent();
        $this->assertStringNotContainsString('SECRET-NOTE', $everything);
        $this->assertStringNotContainsString($noteFile, $everything);
        $this->assertStringNotContainsString('"note"', $everything);
        $this->api($h, 'GET', "/api/v1/help/attachments/{$noteFile}/link")->assertNotFound();
        foreach ([SupportTicketReceivedMail::class, SupportTicketRepliedMail::class,
            SupportTicketStaffMail::class, SupportTicketAssignedMail::class] as $class) {
            Mail::assertNotQueued($class, fn ($m) => str_contains(serialize($m), 'SECRET-NOTE'));
        }
        $this->assertSame(explode(' ', (string) $staff->name)[0], $this->api($h, 'GET', "/api/v1/help/tickets/{$t->id}")->json('data.assignee_name')); // first name only
    }

    public function test_attachment_upload_rules_link_and_signed_download(): void
    {
        [$owner, $tenant, , $h] = $this->liveShop();
        $this->supportUpload($h, 'evil.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>')->assertStatus(422)
            ->assertJsonValidationErrors(['file'], 'error.details');
        $this->supportUpload($h, 'x.webp', $this->imageBytes(64, 64, 'webp'))->assertStatus(422);
        $this->supportUpload($h, 'big.pdf', self::pdfBytes().str_repeat('A', 10 * 1024 * 1024))->assertStatus(422);
        $png = $this->supportUpload($h, 'shot.png', $this->imageBytes(120, 80))->assertCreated()->assertJsonPath('data.kind', 'image')->json('data.id');
        $pdf = $this->supportUpload($h)->assertCreated()->json('data.id');
        $row = $this->inTenant($tenant, fn () => SupportTicketAttachment::query()->findOrFail($pdf));
        $media = $this->inTenant($tenant, fn () => Media::query()->findOrFail($row->media_id));
        $this->assertStringStartsWith("tenants/{$tenant->id}/", $media->path);
        $this->assertSame('support_attachment', $media->purpose);
        $this->assertSame('local', $media->disk);

        // pending upload: only its uploader gets a link
        [, $adminH] = $this->member($tenant, TenantUser::ROLE_ADMIN);
        $this->api($adminH, 'GET', "/api/v1/help/attachments/{$pdf}/link")->assertNotFound();
        $this->api($h, 'POST', '/api/v1/help/tickets', self::ticketBody(['attachment_ids' => [$pdf, $png]]))->assertCreated();
        $url = $this->api($adminH, 'GET', "/api/v1/help/attachments/{$pdf}/link")->assertOk()->json('data.url');

        $this->flushHeaders();
        $this->app['auth']->forgetGuards();
        $dl = $this->get($url)->assertOk();
        $dl->assertHeader('X-Content-Type-Options', 'nosniff')->assertHeader('Content-Security-Policy', "sandbox; default-src 'none'");
        $this->assertStringContainsString('attachment', (string) $dl->headers->get('Content-Disposition'));
        $this->assertStringContainsString('no-store', (string) $dl->headers->get('Cache-Control'));
        $this->get(str_replace('signature=', 'signature=x', $url))->assertForbidden();
        $this->travel(6)->minutes();
        $this->get($url)->assertForbidden();
    }

    public function test_staff_role_and_custom_role_without_the_key_get_403(): void
    {
        [$owner, $tenant, , $h] = $this->liveShop();
        $t = $this->helpTicket($tenant, $owner);
        [, $sh] = $this->member($tenant, TenantUser::ROLE_STAFF);
        foreach ([['GET', '/api/v1/help/tickets'], ['GET', "/api/v1/help/tickets/{$t->id}"], ['GET', "/api/v1/help/tickets/{$t->id}/messages"],
            ['POST', '/api/v1/help/tickets', self::ticketBody()], ['POST', "/api/v1/help/tickets/{$t->id}/resolve"]] as $r) {
            $this->api($sh, $r[0], $r[1], $r[2] ?? [])->assertForbidden()->assertJsonPath('error.code', 'forbidden');
        }
        $this->supportUpload($sh)->assertForbidden();
    }

    public function test_tickets_and_attachments_of_another_tenant_are_404(): void
    {
        [$owner, $tenant, , $h] = $this->liveShop();
        $file = $this->supportUpload($h)->json('data.id');
        $t = $this->api($h, 'POST', '/api/v1/help/tickets', self::ticketBody(['attachment_ids' => [$file]]))->assertCreated()->json('data.id');
        [, , , $hB] = $this->liveShop('intruder');

        $this->assertTenantIsolation($hB, [
            ['GET', "/api/v1/help/tickets/{$t}"],
            ['GET', "/api/v1/help/tickets/{$t}/messages"],
            ['POST', "/api/v1/help/tickets/{$t}/messages", ['body' => 'x', 'client_id' => (string) Str::uuid()]],
            ['POST', "/api/v1/help/tickets/{$t}/resolve"],
            ['PUT', "/api/v1/help/tickets/{$t}/rating", ['rating' => 5]],
            ['GET', "/api/v1/help/attachments/{$file}/link"],
        ]);
        $this->assertSame([], $this->api($hB, 'GET', '/api/v1/help/tickets')->json('data'));
        // another tenant's upload can't be claimed
        $this->api($hB, 'POST', '/api/v1/help/tickets', self::ticketBody(['attachment_ids' => [$file]]))->assertStatus(422);
    }

    public function test_impersonation_reads_but_cannot_write_or_open_attachments(): void
    {
        [, $tenant, , $h] = $this->liveShop();
        $this->helpPublished($this->helpCategory(), 'imp-guide', 'Guide');
        $file = $this->supportUpload($h)->json('data.id');
        $t = $this->api($h, 'POST', '/api/v1/help/tickets', self::ticketBody(['attachment_ids' => [$file]]))->assertCreated()->json('data.id');

        $this->useSpaBrowser();
        $staff = User::factory()->create();
        $staff->forceFill(['platform_role' => 'support'])->save();
        [, $url] = app(ImpersonationService::class)->create($staff, $tenant, 'Customer ticket: help check', 'T-1001', '127.0.0.1', 'phpunit');
        $this->unencryptedCookies = [];
        $this->browser('GET', '/sanctum/csrf-cookie');
        $started = $this->browser('POST', '/api/v1/auth/impersonation', ['ticket' => Str::after($url, '#ticket=')]);
        if ($started->status() === 419) {
            $this->markTestSkipped('SPA session cookie unavailable in this local environment (pre-existing 419).');
        }
        $started->assertOk();
        $x = ['X-Tenant-Id' => $tenant->id];
        $this->browser('GET', '/api/v1/help/tickets', [], $x)->assertOk();
        $this->browser('GET', '/api/v1/help/articles/imp-guide', [], $x)->assertOk();
        $this->browser('GET', "/api/v1/help/attachments/{$file}/link", [], $x)->assertForbidden()->assertJsonPath('error.code', 'impersonation_attachment_hidden');
        foreach ([['POST', '/api/v1/help/tickets'], ['POST', "/api/v1/help/tickets/{$t}/messages"], ['POST', "/api/v1/help/tickets/{$t}/resolve"],
            ['PUT', "/api/v1/help/tickets/{$t}/rating"], ['PUT', '/api/v1/help/articles/imp-guide/feedback'], ['DELETE', '/api/v1/help/articles/imp-guide/feedback'],
            ['POST', '/api/v1/help/attachments']] as [$m, $p]) {
            $this->browser($m, $p, ['rating' => 5], $x)->assertForbidden()->assertJsonPath('error.code', 'impersonation_read_only');
        }
    }

    private function ticket($tenant, string $id): SupportTicket
    {
        return $this->inTenant($tenant, fn () => SupportTicket::query()->findOrFail($id));
    }
}
