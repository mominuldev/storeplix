<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\SenderIds;

use App\Domain\Admin\Impersonation\ImpersonationService;
use App\Domain\Identity\Models\User;
use App\Domain\Media\Models\Media;
use App\Domain\Sms\Mail\SmsMail;
use App\Domain\Sms\Models\SmsSenderId;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\SpaBrowser;
use Tests\TestCase;

/** PHASE-8-9A §8.2, P89A-13 / P89A-15 / P89A-16, S208, S210, S215, S216: merchant sender-ID requests. */
#[Group('sms')]
#[Group('security')]
class SenderIdRequestsTest extends TestCase
{
    use RefreshDatabase, SenderIdFixtures, SpaBrowser;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpSenderIds(throttle: $this->name() === 'test_limiter_five_requests_a_day_per_store');
        Mail::fake();
        config(['billing.ops_email' => 'ops@storeplix.test']);
    }

    public function test_request_list_and_cancel(): void
    {
        [$owner, $tenant, $store, $h] = $this->shop();
        $this->api($h, 'GET', $this->sUrl($store))->assertOk()->assertExactJson(['data' => ['active' => null, 'pending' => null, 'history' => []]]);

        $created = $this->requestId($h, $store)->assertCreated()
            ->assertJsonPath('data.sender_id', 'GlowBD')
            ->assertJsonPath('data.status', 'pending')
            ->assertJsonPath('data.business_name', 'Glow Fashion House')
            ->assertJsonPath('data.uses', ['order_updates', 'otp'])
            ->assertJsonPath('data.note', 'Same name as our Facebook page')
            ->assertJsonPath('data.document', ['mime' => 'application/pdf', 'size_bytes' => strlen(self::pdf()), 'filename' => 'Trade licence.pdf'])
            ->assertJsonPath('data.requested_by.id', $owner->id)
            ->assertJsonPath('data.reviewed_at', null)
            ->assertJsonPath('data.decision_reason', null)
            ->json('data');
        $this->assertArrayNotHasKey('url', $created['document']);

        $row = $this->senderRow($tenant, $created['id']);
        $media = $this->platformQuery(Media::class)->findOrFail($row->document_media_id);
        $this->assertSame(['sender_id_document', 'local', Media::READY], [$media->purpose, $media->disk, $media->status]);
        $this->assertSame("tenants/{$tenant->id}/media/{$media->id}/original.pdf", $media->path);
        Storage::disk('local')->assertExists($media->path);
        $this->assertSame([], Storage::disk('public')->allFiles());

        // Never in the media library (S216).
        $this->api($h, 'GET', '/api/v1/media')->assertOk()->assertJsonCount(0, 'data');
        $this->api($h, 'GET', "/api/v1/media/{$media->id}")->assertNotFound();

        $this->api($h, 'GET', $this->sUrl($store))->assertOk()
            ->assertJsonPath('data.active', null)->assertJsonPath('data.pending.id', $created['id'])->assertJsonCount(1, 'data.history');

        Mail::assertQueued(SmsMail::class, fn (SmsMail $m) => $m->kind === SmsMail::SENDER_ID_REQUESTED && $m->hasTo($owner->email));
        Mail::assertQueued(SmsMail::class, fn (SmsMail $m) => $m->kind === SmsMail::SENDER_ID_REQUESTED_OPS && $m->hasTo('ops@storeplix.test'));
        $audit = $this->platformTable('audit_logs')->where('tenant_id', $tenant->id)->where('action', 'sender_id.requested')->sole();
        $this->assertSame('sender_id', $audit->subject_type);
        $this->assertSame(['sender_id' => 'GlowBD', 'uses' => ['order_updates', 'otp'], 'document_media_id' => $media->id, 'rights_confirmed' => true], json_decode($audit->meta, true));

        $this->api($h, 'POST', $this->sUrl($store, "/{$created['id']}/cancel"))->assertOk()->assertJsonPath('data.status', 'cancelled');
        $this->api($h, 'POST', $this->sUrl($store, "/{$created['id']}/cancel"))->assertStatus(409)->assertJsonPath('error.code', 'invalid_state_transition');
        $this->assertNotNull($this->senderRow($tenant, $created['id'])->ended_at);
        $this->assertSame(1, $this->platformTable('audit_logs')->where('tenant_id', $tenant->id)->where('action', 'sender_id.cancelled')->count());
        $this->assertSame(1, $this->platformQuery(Media::class)->whereKey($media->id)->count(), 'the document row is kept');

        // A new request after the cancel; the history lists both, newest first.
        $again = $this->requestId($h, $store, ['sender_id' => 'GLOWBD'])->assertCreated()->json('data.id');
        $this->api($h, 'GET', $this->sUrl($store))->assertOk()->assertJsonPath('data.history.0.id', $again)->assertJsonPath('data.history.1.id', $created['id']);
    }

    public function test_validation_matrix(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        $cases = [
            'too short' => [['sender_id' => 'AB'], 'sender_id'],
            'too long' => [['sender_id' => 'ABCDEFGHIJKL'], 'sender_id'],
            'digits only' => [['sender_id' => '12345'], 'sender_id'],
            'symbols' => [['sender_id' => 'Glow-BD'], 'sender_id'],
            'business name' => [['business_name' => 'A'], 'business_name'],
            'no uses' => [['uses' => []], 'uses'],
            'promotions' => [['uses' => ['promotions']], 'uses.0'],
            'duplicate uses' => [['uses' => ['otp', 'otp']], 'uses.0'],
            'rights not ticked' => [['rights_confirmed' => '0'], 'rights_confirmed'],
            'rights missing' => [['rights_confirmed' => null], 'rights_confirmed'],
            'note' => [['note' => str_repeat('n', 301)], 'note'],
            'no document' => [['document' => null], 'document'],
        ];
        foreach ($cases as $label => [$override, $field]) {
            $r = $this->requestId($h, $store, $override)->assertUnprocessable()->assertJsonPath('error.code', 'validation_failed');
            $this->assertArrayHasKey($field, (array) $r->json('error.details'), "case: {$label}");
        }
        $files = [
            'svg' => UploadedFile::fake()->createWithContent('l.svg', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
            'html' => UploadedFile::fake()->createWithContent('l.html', '<!doctype html><html></html>'),
            'jpeg named .pdf' => UploadedFile::fake()->createWithContent('l.pdf', $this->imageBytes(300, 300, 'jpeg')),
            'over 5 MB' => UploadedFile::fake()->createWithContent('l.pdf', "%PDF-1.4\n".str_repeat('x', 5 * 1024 * 1024)."\n%%EOF\n"),
        ];
        foreach ($files as $label => $file) {
            $r = $this->requestId($h, $store, [], $file)->assertUnprocessable();
            $this->assertArrayHasKey('document', (array) $r->json('error.details'), "file: {$label}");
        }
        $this->assertSame(0, $this->platformQuery(Media::class)->where('tenant_id', $tenant->id)->count());
        $this->assertSame([], Storage::disk('local')->allFiles());

        // An image licence is accepted and re-encoded (queue is sync: ready, EXIF-free original in place).
        $id = $this->requestId($h, $store, ['sender_id' => 'ImgShop'], UploadedFile::fake()->createWithContent('scan.png', $this->imageBytes(400, 300)))
            ->assertCreated()->assertJsonPath('data.document.mime', 'image/png')->json('data.id');
        $media = $this->platformQuery(Media::class)->findOrFail($this->senderRow($tenant, $id)->document_media_id);
        $this->assertSame([Media::READY, []], [$media->status, $media->variants]);
    }

    public function test_reserved_unchanged_pending_and_taken(): void
    {
        config(['sms.revesms.caller_id' => 'Storeplix']);
        [, $tenantA, $storeA, $hA] = $this->shop(slug: 'alpha');
        [, $tenantB, $storeB, $hB] = $this->shop(slug: 'beta');

        foreach (['storeplix', 'BKASH', 'Nagad'] as $reserved) {
            $this->requestId($hA, $storeA, ['sender_id' => $reserved])->assertUnprocessable()->assertJsonPath('error.code', 'sender_id_reserved');
        }
        $pending = $this->requestId($hA, $storeA, ['sender_id' => 'Rongdhonu'])->assertCreated()->json('data.id');
        $this->requestId($hA, $storeA, ['sender_id' => 'Another'])->assertStatus(409)
            ->assertJsonPath('error.code', 'sender_id_request_pending')->assertJsonPath('error.details.request_id', $pending);

        // Taken across shops, case-insensitively (pending of shop A); the failed upload leaves no file behind.
        $files = count(Storage::disk('local')->allFiles());
        $this->requestId($hB, $storeB, ['sender_id' => 'RONGDHONU'])->assertStatus(409)->assertJsonPath('error.code', 'sender_id_taken');
        $this->assertCount($files, Storage::disk('local')->allFiles());
        $this->assertSame(0, $this->platformQuery(Media::class)->where('tenant_id', $tenantB->id)->count());

        // Approved for A → asking for the same ID again is "unchanged"; B still can't take it.
        $this->inTenant($tenantA, fn () => SmsSenderId::query()->whereKey($pending)->update(['status' => SmsSenderId::APPROVED, 'approved_at' => now()]));
        $this->requestId($hA, $storeA, ['sender_id' => 'rongDHONU'])->assertUnprocessable()->assertJsonPath('error.code', 'sender_id_unchanged');
        $this->requestId($hB, $storeB, ['sender_id' => 'Rongdhonu'])->assertStatus(409)->assertJsonPath('error.code', 'sender_id_taken');
        $this->requestId($hB, $storeB, ['sender_id' => 'Rongdhonu2'])->assertCreated();
        $this->assertSame(1, $this->platformQuery(SmsSenderId::class)->where('tenant_id', $tenantB->id)->count());
    }

    #[Group('tenancy')]
    public function test_permissions_isolation_and_impersonation(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        [, $admin] = $this->member($tenant, TenantUser::ROLE_ADMIN);
        [, $staff] = $this->member($tenant, TenantUser::ROLE_STAFF);

        $id = $this->requestId($admin, $store)->assertCreated()->json('data.id');
        $this->api($admin, 'GET', $this->sUrl($store))->assertOk();
        $this->api($staff, 'GET', $this->sUrl($store))->assertForbidden();
        $this->requestId($staff, $store, ['sender_id' => 'Other'])->assertForbidden();
        $this->api($staff, 'POST', $this->sUrl($store, "/{$id}/cancel"))->assertForbidden();

        // Another tenant: its store and the request id are 404 (S208).
        [, $tenantB, $storeB, $hB] = $this->shop(slug: 'other');
        $otherId = $this->requestId($hB, $storeB, ['sender_id' => 'OtherShop'])->assertCreated()->json('data.id');
        $this->assertTenantIsolation($h, [
            ['GET', $this->sUrl($storeB)],
            ['POST', $this->sUrl($storeB, "/{$otherId}/cancel")],
            ['POST', $this->sUrl($store, "/{$otherId}/cancel")],
        ]);
        $this->assertStoreIsolation(SmsSenderId::class, $tenant, $store, $storeB);
        $this->assertSame('pending', $this->senderRow($tenantB, $otherId)->status);

        // Impersonation: reads work, writes 403.
        $this->useSpaBrowser();
        $support = User::factory()->create();
        $support->forceFill(['platform_role' => 'support'])->save();
        [, $url] = app(ImpersonationService::class)->create($support, $tenant, 'Customer ticket: sender ID', 'ZD-89', '127.0.0.1', 'phpunit');
        $this->unencryptedCookies = [];
        $this->browser('GET', '/sanctum/csrf-cookie');
        $this->browser('POST', '/api/v1/auth/impersonation', ['ticket' => Str::after($url, '#ticket=')])->assertOk();
        $t = ['X-Tenant-Id' => $tenant->id];
        $this->browser('GET', $this->sUrl($store), [], $t)->assertOk()->assertJsonPath('data.pending.id', $id);
        $this->browser('POST', $this->sUrl($store, "/{$id}/cancel"), [], $t)->assertForbidden()->assertJsonPath('error.code', 'impersonation_read_only');
        $this->assertSame('pending', $this->senderRow($tenant, $id)->status);
    }

    public function test_limiter_five_requests_a_day_per_store(): void
    {
        [, , $store, $h] = $this->shop();
        for ($i = 0; $i < 5; $i++) {
            $this->requestId($h, $store, ['sender_id' => 'AB'])->assertUnprocessable(); // validation failures count too
        }
        $this->requestId($h, $store)->assertStatus(429);
    }
}
