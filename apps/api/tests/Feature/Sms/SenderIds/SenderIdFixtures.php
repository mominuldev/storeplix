<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\SenderIds;

use App\Domain\Identity\Models\User;
use App\Domain\Sms\Models\SmsSenderId;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Http\UploadedFile;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Storage;
use Illuminate\Testing\TestResponse;
use Tests\Support\CommerceFixtures;
use Tests\Support\PlatformStaffFixtures;

/** PHASE-8-9A §8 helpers: sender-ID requests through the API (multipart), fake disks, admin calls. */
trait SenderIdFixtures
{
    use CommerceFixtures, PlatformStaffFixtures;

    protected function setUpSenderIds(bool $throttle = false): void
    {
        if (! $throttle) {
            $this->withoutMiddleware(ThrottleRequests::class);
        }
        Storage::fake('local');
        Storage::fake('public');
    }

    protected function sUrl(Store $store, string $suffix = ''): string
    {
        return "/api/v1/stores/{$store->id}/sms/sender-ids".$suffix;
    }

    protected static function pdf(): string
    {
        return "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n";
    }

    /** @param array<string, mixed> $override */
    protected function requestId(array $h, Store $store, array $override = [], ?UploadedFile $document = null): TestResponse
    {
        $body = $override + [
            'sender_id' => 'GlowBD',
            'business_name' => 'Glow Fashion House',
            'uses' => ['order_updates', 'otp'],
            'rights_confirmed' => '1',
            'note' => 'Same name as our Facebook page',
        ];
        if (! array_key_exists('document', $override)) {
            $body['document'] = $document ?? UploadedFile::fake()->createWithContent('Trade licence.pdf', self::pdf());
        }
        $body = array_filter($body, fn ($v) => $v !== null);

        return $this->flushHeaders()->withHeaders($h)->post($this->sUrl($store), $body, ['Accept' => 'application/json']);
    }

    /** @param array<string, mixed> $body */
    protected function admin(User $as, string $method, string $uri, array $body = [], array $headers = []): TestResponse
    {
        return $this->flushHeaders()->asAdminSurface()->withHeaders($this->adminHeaders($as) + $headers)->json($method, '/api/v1/admin/'.$uri, $body);
    }

    /**
     * Cross-tenant access (MULTI-TENANCY §10a): every URL → 404 `not_found` for tenant A.
     *
     * @param  list<array{0: string, 1: string, 2?: array<string, mixed>}>  $requests
     */
    protected function assertTenantIsolation(array $headersA, array $requests): void
    {
        foreach ($requests as $request) {
            $this->flushHeaders()->withHeaders($headersA)->json($request[0], $request[1], $request[2] ?? [])
                ->assertNotFound()->assertJsonPath('error.code', 'not_found');
        }
    }

    protected function senderRow(Tenant $tenant, string $id): SmsSenderId
    {
        return $this->inTenant($tenant, fn () => SmsSenderId::query()->findOrFail($id));
    }
}
