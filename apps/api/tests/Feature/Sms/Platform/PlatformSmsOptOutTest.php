<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\Platform;

use App\Domain\Sms\Broadcasts\BroadcastTexts;
use App\Domain\Tenancy\Models\AuditLog;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-9B §7.6 (P89B-21, S229): the public opt-out link (GET never changes anything, POST idempotent, unknown → 404,
 * `test`, limiter 30/min per IP) and the account switch (own row only; impersonation writes are refused by
 * ReadOnlyImpersonation — covered route-by-route in ImpersonationTest's live-route dataset).
 */
#[Group('platform-sms')]
#[Group('sms')]
#[Group('security')]
class PlatformSmsOptOutTest extends TestCase
{
    use PlatformSmsFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpPlatformSms();
    }

    /** A recipient row with a known code. */
    private function recipient(): array
    {
        [$owner, $tenant] = $this->owner('alpha');
        $broadcast = strtolower((string) Str::ulid());
        $this->platformTable('platform_sms_broadcasts')->insert(['id' => $broadcast, 'name' => 'X', 'body_bn' => 'x', 'body_en' => 'x',
            'audience' => '{"kind":"all"}', 'status' => 'sent', 'created_at' => now(), 'updated_at' => now()]);
        $code = BroadcastTexts::newCode();
        $this->platformTable('platform_sms_broadcast_recipients')->insert(['id' => strtolower((string) Str::ulid()), 'broadcast_id' => $broadcast,
            'tenant_id' => $tenant->id, 'user_id' => $owner->id, 'to' => $owner->phone, 'language' => 'bn', 'status' => 'sent',
            'opt_out_code_hash' => hash('sha256', $code), 'created_at' => now(), 'updated_at' => now()]);

        return [$owner, $code];
    }

    public function test_link_lookup_and_idempotent_opt_out(): void
    {
        [$owner, $code] = $this->recipient();
        $masked = '0'.substr((string) $owner->phone, 3, 4).'-•••'.substr((string) $owner->phone, -3);
        $this->getJson("/api/v1/platform-sms/opt-out/{$code}")->assertOk()->assertJsonPath('data', ['status' => 'subscribed', 'phone_masked' => $masked])
            ->assertHeader('X-Robots-Tag', 'noindex');
        $this->getJson("/api/v1/platform-sms/opt-out/{$code}")->assertOk(); // GET never opts out
        $this->assertNull($owner->refresh()->platform_promo_sms_opted_out_at);

        $this->postJson("/api/v1/platform-sms/opt-out/{$code}")->assertOk()->assertJsonPath('data.status', 'opted_out');
        $this->postJson("/api/v1/platform-sms/opt-out/{$code}")->assertOk()->assertJsonPath('data.status', 'opted_out');
        $owner->refresh();
        $this->assertNotNull($owner->platform_promo_sms_opted_out_at);
        $this->assertSame('link', $owner->platform_promo_sms_opt_out_source);
        $audit = $this->platformQuery(AuditLog::class)->where('action', 'platform_sms.opted_out')->sole();
        $this->assertSame('system', $audit->actor_type);
        $this->assertSame($owner->id, $audit->subject_id);
        $this->assertStringNotContainsString($code, (string) json_encode($audit->meta));
        $this->getJson("/api/v1/platform-sms/opt-out/{$code}")->assertJsonPath('data.status', 'opted_out');

        $this->getJson('/api/v1/platform-sms/opt-out/Zz9Zz9Zz9Z')->assertNotFound();
        $this->postJson('/api/v1/platform-sms/opt-out/Zz9Zz9Zz9Z')->assertNotFound();
        $this->getJson('/api/v1/platform-sms/opt-out/abc')->assertNotFound();
        $this->getJson('/api/v1/platform-sms/opt-out/test')->assertOk()->assertJsonPath('data', ['status' => 'subscribed', 'phone_masked' => '01•••-•••000']);
        $this->postJson('/api/v1/platform-sms/opt-out/test')->assertOk()->assertJsonPath('data.status', 'subscribed');
    }

    public function test_opt_out_limiter(): void
    {
        for ($i = 0; $i < 30; $i++) {
            $this->getJson('/api/v1/platform-sms/opt-out/Zz9Zz9Zz9Z')->assertNotFound();
        }
        $this->getJson('/api/v1/platform-sms/opt-out/Zz9Zz9Zz9Z')->assertStatus(429);
    }

    public function test_account_preferences(): void
    {
        [$owner] = $this->owner('alpha');
        $h = ['X-Testing-User' => $owner->id];
        $this->getJson('/api/v1/account/sms-preferences')->assertUnauthorized();
        $this->withHeaders($h)->getJson('/api/v1/account/sms-preferences')->assertOk()
            ->assertJsonPath('data.promotional', true)->assertJsonPath('data.phone_verified', true)->assertJsonPath('data.source', null)
            ->assertJsonPath('data.phone_masked', fn ($v) => is_string($v) && str_contains($v, '-•••'));
        $this->withHeaders($h)->patchJson('/api/v1/account/sms-preferences', ['promotional' => 'x'])->assertStatus(422);
        $this->withHeaders($h)->patchJson('/api/v1/account/sms-preferences', ['promotional' => false])->assertOk()
            ->assertJsonPath('data.promotional', false)->assertJsonPath('data.source', 'account');
        $this->withHeaders($h)->patchJson('/api/v1/account/sms-preferences', ['promotional' => false])->assertOk();
        $this->withHeaders($h)->patchJson('/api/v1/account/sms-preferences', ['promotional' => true])->assertOk()
            ->assertJsonPath('data.promotional', true)->assertJsonPath('data.opted_out_at', null);
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('action', 'platform_sms.opted_out')->count());
        $this->assertSame(1, $this->platformQuery(AuditLog::class)->where('action', 'platform_sms.opted_in')->count());

        // No phone at all.
        [$other] = $this->merchant();
        $this->withHeaders(['X-Testing-User' => $other->id])->getJson('/api/v1/account/sms-preferences')->assertOk()
            ->assertJsonPath('data.phone_masked', null)->assertJsonPath('data.phone_verified', false);
        // An admin-surface session can't use the merchant account route.
        $this->asAdminSurface()->flushHeaders()->withHeaders($this->adminHeaders($this->super()))->getJson('/api/v1/account/sms-preferences')->assertForbidden();
    }
}
