<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\SenderIds;

use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Media\Models\Media;
use App\Domain\Orders\Notifications\SendOrderSms;
use App\Domain\Sms\Mail\SmsMail;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\Models\SmsSenderId;
use App\Domain\Sms\SmsGateway;
use App\Domain\Sms\SmsSender;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/** PHASE-8-9A §8.3, §10.3, P89A-14 / P89A-17, S215, S216: the staff review queue and its effect on the shop's SMS. */
#[Group('sms')]
#[Group('admin')]
#[Group('security')]
class AdminSenderIdsTest extends TestCase
{
    use RefreshDatabase, SenderIdFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpSenderIds();
        Mail::fake();
        config(['admin.ip_allowlist' => [], 'admin.email_domains' => []]);
    }

    private function document(string $id, string $accept = 'application/json'): TestResponse
    {
        $support = $this->staffUser(PlatformRole::Support);

        return $this->flushHeaders()->asAdminSurface()->withHeaders($this->adminHeaders($support) + ['Accept' => $accept])
            ->get("/api/v1/admin/sender-ids/{$id}/document");
    }

    /** One SMS for an order of the shop (order_confirmed, bn: the template starts with "{shop}: "). @return array{to: string, text: string, sender_id: string|null} */
    private function orderSms(Tenant $tenant, Store $store, array $h): array
    {
        [, $variant] = $this->stocked($h, $store, 1000, 50);
        $id = $this->manual($h, $store, $this->manualBody($variant, 1, ['notify_customer' => false]))->json('data.id');
        dispatch((new SendOrderSms($id, 'order_confirmed'))->forTenant($tenant->id));
        $sent = app(SmsGateway::class)->sent;

        return end($sent);
    }

    public function test_queue_filters_detail_and_document(): void
    {
        $support = $this->staffUser(PlatformRole::Support);
        [$ownerA, $tenantA, $storeA, $hA] = $this->liveShop('alpha');
        [, $tenantB, $storeB, $hB] = $this->liveShop('beta');
        $first = $this->requestId($hA, $storeA, ['sender_id' => 'AlphaBD'])->assertCreated()->json('data.id');
        $this->travel(1)->minutes();
        $second = $this->requestId($hB, $storeB, ['sender_id' => 'BetaShop'])->assertCreated()->json('data.id');

        $this->admin($support, 'GET', 'sender-ids')->assertOk()
            ->assertJsonPath('meta.total', 2)->assertJsonPath('meta.counts.pending', 2)
            ->assertJsonPath('data.0.id', $first) // pending: oldest first
            ->assertJsonPath('data.1.id', $second)
            ->assertJsonPath('data.0.tenant', ['id' => $tenantA->id, 'name' => $storeA->name, 'slug' => $storeA->slug])
            ->assertJsonPath('data.0.requested_by_email', $ownerA->email)
            ->assertJsonPath('data.0.reviewed_by', null)
            ->assertJsonPath('data.0.current_sender_id', null)
            ->assertJsonPath('data.0.document.filename', 'Trade licence.pdf');
        $this->admin($support, 'GET', 'sender-ids?filter[q]=beta')->assertOk()->assertJsonPath('meta.total', 1)->assertJsonPath('data.0.id', $second);
        $this->admin($support, 'GET', 'sender-ids?filter[q]=alphabd')->assertJsonPath('meta.total', 1)->assertJsonPath('data.0.id', $first);
        $this->admin($support, 'GET', 'sender-ids?filter[q]=a')->assertUnprocessable();
        $this->admin($support, 'GET', 'sender-ids?filter[status]=approved')->assertOk()->assertJsonPath('meta.total', 0)->assertJsonPath('meta.counts.pending', 2);
        $this->admin($support, 'GET', 'sender-ids?filter[status]=nope')->assertUnprocessable();
        $this->admin($support, 'GET', "sender-ids/{$second}")->assertOk()->assertJsonPath('data.sender_id', 'BetaShop')->assertJsonPath('data.tenant.id', $tenantB->id);
        $this->admin($support, 'GET', 'sender-ids/'.strtolower((string) Str::ulid()))->assertNotFound();

        // Document: streamed as an attachment for the api-client's blob Accept header too (no 406 / JSON); audited.
        foreach (['text/csv, application/json', 'application/json', '*/*'] as $accept) {
            $response = $this->document($first, $accept)->assertOk();
            $this->assertSame(self::pdf(), $response->streamedContent(), $accept);
            $this->assertSame('application/pdf', $response->headers->get('Content-Type'));
            $this->assertSame('nosniff', $response->headers->get('X-Content-Type-Options'));
            $this->assertSame("sandbox; default-src 'none'", $response->headers->get('Content-Security-Policy'));
            $this->assertStringContainsString('no-store', (string) $response->headers->get('Cache-Control'));
            $this->assertStringStartsWith('attachment;', (string) $response->headers->get('Content-Disposition'));
        }
        $viewed = $this->platformTable('audit_logs')->where('tenant_id', $tenantA->id)->where('action', 'sender_id.document_viewed')->get();
        $this->assertCount(3, $viewed);
        $this->assertSame('platform_user', $viewed[0]->actor_type);

        // An image still being re-encoded → 409 document_processing.
        Queue::fake();
        $this->inTenant($tenantB, fn () => SmsSenderId::query()->whereKey($second)->update(['status' => SmsSenderId::CANCELLED]));
        $image = $this->requestId($hB, $storeB, ['sender_id' => 'BetaImg'], UploadedFile::fake()->createWithContent('scan.png', $this->imageBytes(400, 300)))
            ->assertCreated()->json('data.id');
        $this->document($image, 'text/csv, application/json')->assertStatus(409)->assertJsonPath('error.code', 'document_processing');

        // Roles without manage_domains (billing) → 403.
        $billing = $this->staffUser(PlatformRole::Billing);
        $this->admin($billing, 'GET', 'sender-ids')->assertForbidden();
        $this->admin($billing, 'POST', "sender-ids/{$first}/approve", ['provider_registered' => true, 'reason' => 'Registered on REVE'])->assertForbidden();
    }

    public function test_approve_supersede_reject_revoke_and_the_caller_id(): void
    {
        $support = $this->staffUser(PlatformRole::Support);
        [$owner, $tenant, $store, $h] = $this->liveShop();
        $first = $this->requestId($h, $store, ['sender_id' => 'GlowBD'])->assertCreated()->json('data.id');

        // Shared sender before approval: the "{Shop}: " prefix, no caller ID.
        $sms = $this->orderSms($tenant, $store, $h);
        $this->assertNull($sms['sender_id']);
        $this->assertStringStartsWith($store->name.': ', $sms['text']);
        $this->inTenant($tenant, fn () => $this->assertNull(SmsSender::for($store))); // cached "none"

        $this->admin($support, 'POST', "sender-ids/{$first}/approve", ['reason' => 'Registered on REVE'])->assertUnprocessable();
        $this->admin($support, 'POST', "sender-ids/{$first}/approve", ['provider_registered' => false, 'reason' => 'Registered on REVE'])->assertUnprocessable();
        $this->admin($support, 'POST', "sender-ids/{$first}/approve", ['provider_registered' => true, 'reason' => 'ok'])->assertUnprocessable();
        $this->admin($support, 'POST', "sender-ids/{$first}/approve", ['provider_registered' => true, 'reason' => 'Registered on REVE / BTRC'])->assertOk()
            ->assertJsonPath('data.status', 'approved')->assertJsonPath('data.reviewed_by.id', $support->id)
            ->assertJsonPath('data.decision_reason', 'Registered on REVE / BTRC')->assertJsonPath('data.current_sender_id', 'GlowBD');
        $this->admin($support, 'POST', "sender-ids/{$first}/approve", ['provider_registered' => true, 'reason' => 'Registered on REVE / BTRC'])
            ->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
        Mail::assertQueued(SmsMail::class, fn (SmsMail $m) => $m->kind === SmsMail::SENDER_ID_APPROVED && $m->hasTo($owner->email));
        $audit = $this->platformTable('audit_logs')->where('tenant_id', $tenant->id)->where('action', 'sender_id.approved')->sole();
        $this->assertSame('platform_user', $audit->actor_type);
        $this->assertSame('Registered on REVE / BTRC', json_decode($audit->meta, true)['reason']);

        // The cache was flushed: the next SMS goes out with the masked ID and without the prefix (P89A-17).
        $sms = $this->orderSms($tenant, $store, $h);
        $this->assertSame('GlowBD', $sms['sender_id']);
        $this->assertStringStartsNotWith($store->name.': ', $sms['text']);
        $this->assertSame('GlowBD', $this->platformQuery(SmsMessage::class)->where('tenant_id', $tenant->id)->latest('id')->value('sender_id'));
        $this->api($h, 'GET', $this->sUrl($store))->assertOk()->assertJsonPath('data.active.id', $first)->assertJsonPath('data.pending', null);

        // A second request: rejected with a reason shown to the merchant.
        $second = $this->requestId($h, $store, ['sender_id' => 'GlowFash'])->assertCreated()->json('data.id');
        $this->admin($support, 'POST', "sender-ids/{$second}/reject", ['reason' => 'Licence name does not match'])->assertOk()
            ->assertJsonPath('data.status', 'rejected');
        $this->admin($support, 'POST', "sender-ids/{$second}/revoke", ['reason' => 'Not approved anyway'])->assertStatus(409);
        $this->api($h, 'GET', $this->sUrl($store))->assertOk()->assertJsonPath('data.history.0.decision_reason', 'Licence name does not match');
        Mail::assertQueued(SmsMail::class, fn (SmsMail $m) => $m->kind === SmsMail::SENDER_ID_REJECTED && $m->data['reason'] === 'Licence name does not match');

        // A third request approved → the first one is superseded.
        $third = $this->requestId($h, $store, ['sender_id' => 'GlowNew'])->assertCreated()->json('data.id');
        $this->admin($support, 'GET', "sender-ids/{$third}")->assertJsonPath('data.current_sender_id', 'GlowBD');
        $this->admin($support, 'POST', "sender-ids/{$third}/approve", ['provider_registered' => true, 'reason' => 'Registered on REVE'])->assertOk();
        $this->assertSame(SmsSenderId::SUPERSEDED, $this->senderRow($tenant, $first)->status);
        $this->assertNotNull($this->senderRow($tenant, $first)->ended_at);
        $this->assertSame('GlowNew', $this->orderSms($tenant, $store, $h)['sender_id']);

        // Revoke: falls back to the shared sender from the next message.
        $this->admin($support, 'POST', "sender-ids/{$third}/revoke", ['reason' => 'Abuse report'])->assertOk()->assertJsonPath('data.status', 'revoked');
        $sms = $this->orderSms($tenant, $store, $h);
        $this->assertNull($sms['sender_id']);
        $this->assertStringStartsWith($store->name.': ', $sms['text']);
        Mail::assertQueued(SmsMail::class, fn (SmsMail $m) => $m->kind === SmsMail::SENDER_ID_REVOKED);
        $this->assertSame(1, $this->platformTable('audit_logs')->where('tenant_id', $tenant->id)->where('action', 'sender_id.revoked')->count());
    }

    public function test_prune_finished_request_documents(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        $old = $this->requestId($h, $store, ['sender_id' => 'OldOne'])->assertCreated()->json('data.id');
        $this->api($h, 'POST', $this->sUrl($store, "/{$old}/cancel"))->assertOk();
        $live = $this->requestId($h, $store, ['sender_id' => 'LiveOne'])->assertCreated()->json('data.id');
        $oldMedia = $this->platformQuery(Media::class)->findOrFail($this->senderRow($tenant, $old)->document_media_id);
        $liveMedia = $this->platformQuery(Media::class)->findOrFail($this->senderRow($tenant, $live)->document_media_id);

        $this->artisan('sms:prune-sender-documents')->assertExitCode(0);
        Storage::disk('local')->assertExists($oldMedia->path); // not old enough yet

        $this->travel(181)->days();
        $this->artisan('sms:prune-sender-documents')->assertExitCode(0);
        Storage::disk('local')->assertMissing($oldMedia->path);
        Storage::disk('local')->assertExists($liveMedia->path); // pending: kept
        $this->assertSame(Media::FAILED, $this->platformQuery(Media::class)->findOrFail($oldMedia->id)->status);
        $this->assertSame($oldMedia->id, $this->senderRow($tenant, $old)->document_media_id, 'the row stays (RESTRICT)');
        $this->document($old)->assertNotFound();
        $this->artisan('sms:prune-sender-documents')->assertExitCode(0); // idempotent
    }
}
