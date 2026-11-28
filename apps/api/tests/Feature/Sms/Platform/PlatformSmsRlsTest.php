<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\Platform;

use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Tenancy\Database\RlsPolicies;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\RlsFixtures;
use Tests\TestCase;

/**
 * PHASE-8-9B S230 / S233 on Postgres with RLS (CI api-rls): the app role may only SELECT providers, types and templates
 * and has no privilege at all on the broadcast tables; platform SMS rows (`tenant_id` NULL + `merchant_tenant_id`) are
 * never visible inside a tenant.
 */
#[Group('platform-sms')]
#[Group('rls')]
#[Group('security')]
class PlatformSmsRlsTest extends TestCase
{
    use PlatformSmsFixtures, RefreshDatabase, RlsFixtures {
        PlatformSmsFixtures::owner insteadof RlsFixtures;
    }

    public function test_grants_on_the_platform_sms_tables(): void
    {
        $this->requireRls();
        $role = RlsPolicies::APP_ROLE;
        foreach (['sms_providers', 'platform_sms_message_types', 'platform_sms_templates'] as $table) {
            $this->assertTrue((bool) DB::selectOne('select has_table_privilege(?, ?, ?) as v', [$role, $table, 'SELECT'])->v, $table);
            foreach (['INSERT', 'UPDATE', 'DELETE'] as $privilege) {
                $this->assertFalse((bool) DB::selectOne('select has_table_privilege(?, ?, ?) as v', [$role, $table, $privilege])->v, "{$table} {$privilege}");
            }
        }
        foreach (['platform_sms_broadcasts', 'platform_sms_broadcast_recipients'] as $table) {
            foreach (['SELECT', 'INSERT', 'UPDATE', 'DELETE'] as $privilege) {
                $this->assertFalse((bool) DB::selectOne('select has_table_privilege(?, ?, ?) as v', [$role, $table, $privilege])->v, "{$table} {$privilege}");
            }
            $this->assertSame('42501', $this->sqlState(fn () => DB::select("select count(*) from {$table}")));
        }
    }

    public function test_platform_rows_are_invisible_inside_a_tenant(): void
    {
        $this->requireRls();
        $this->setUpPlatformSms();
        [, $tenant] = $this->owner('alpha');
        $this->platformTable('sms_messages')->insert(['id' => strtolower((string) Str::ulid()), 'tenant_id' => null, 'merchant_tenant_id' => $tenant->id,
            'to' => '8801711552211', 'purpose' => 'platform_welcome', 'template' => 't', 'status' => 'sent', 'created_at' => now(), 'updated_at' => now()]);
        $this->assertSame(0, $this->inTenant($tenant, fn () => SmsMessage::query()->where('merchant_tenant_id', $tenant->id)->count()));
        $this->assertSame(1, $this->platformTable('sms_messages')->where('merchant_tenant_id', $tenant->id)->count());
    }
}
