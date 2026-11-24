<?php

declare(strict_types=1);

namespace Tests\Feature\Automations;

use App\Domain\Admin\Impersonation\ImpersonationService;
use App\Domain\Identity\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\SpaBrowser;
use Tests\TestCase;

/** S131: an impersonation session (read-only, P8-10) reads automations but can't PATCH / enable / test. */
#[Group('automations')]
#[Group('security')]
class AutomationImpersonationTest extends TestCase
{
    use AutomationFixtures, RefreshDatabase, SpaBrowser;

    public function test_impersonation_is_read_only_for_automations(): void
    {
        $this->setUpCampaigns();
        [, $tenant, $store, $h] = $this->campaignShop();
        $a = $this->createAutomation($h, $store, 'thank_you');

        $this->useSpaBrowser();
        Mail::fake();
        $staff = User::factory()->create();
        $staff->forceFill(['platform_role' => 'support'])->save();
        [, $url] = app(ImpersonationService::class)->create($staff, $tenant, 'Customer ticket: automations check', 'ZD-86', '127.0.0.1', 'phpunit');
        $this->unencryptedCookies = [];
        $this->browser('GET', '/sanctum/csrf-cookie');
        $this->browser('POST', '/api/v1/auth/impersonation', ['ticket' => Str::after($url, '#ticket=')])->assertOk();
        $t = ['X-Tenant-Id' => $tenant->id];

        $this->browser('GET', $this->aUrl($store), [], $t)->assertOk();
        $this->browser('GET', $this->aUrl($store, "/{$a['id']}"), [], $t)->assertOk();
        $this->browser('PATCH', $this->aUrl($store, "/{$a['id']}"), ['name' => 'Hijack', 'revision' => 1], $t)->assertForbidden();
        $this->browser('POST', $this->aUrl($store, "/{$a['id']}/enable"), [], $t)->assertForbidden();
        $this->browser('POST', $this->aUrl($store, "/{$a['id']}/test-message"), ['step' => 1], $t)->assertForbidden();
        $this->assertSame('draft', $this->automationRow($tenant, $a['id'])->status);
    }
}
