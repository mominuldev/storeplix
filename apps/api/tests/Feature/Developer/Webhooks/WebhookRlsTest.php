<?php

declare(strict_types=1);

namespace Tests\Feature\Developer\Webhooks;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\RlsFixtures;
use Tests\TestCase;

/**
 * S110 at the database (PHASE-8-4 §5.1): the three webhook tables are under forced RLS. With tenant A's GUC, raw SQL
 * sees none of B's endpoints, secrets or deliveries and can't write a row for B; with no tenant it sees nothing.
 * Runs only with TENANCY_RLS=true on Postgres as storeplix_app (CI api-rls).
 */
#[Group('developer-api')]
#[Group('rls')]
#[Group('security')]
class WebhookRlsTest extends TestCase
{
    use RefreshDatabase, RlsFixtures, WebhookFixtures;

    public function test_webhook_tables_are_isolated_by_row_level_security(): void
    {
        $this->requireRls();
        $this->setUpWebhooks();
        Http::fake(['hooks.example.com/*' => Http::response('ok', 200)]);
        [, $tenantA, $storeA, $hA] = $this->growthShop('alpha');
        [, $tenantB, $storeB, $hB] = $this->growthShop('beta');
        foreach ([[$hA, $storeA], [$hB, $storeB]] as [$h, $store]) {
            $id = $this->endpointId($h, $store);
            $this->api($h, 'POST', $this->hookUrl($store, "/{$id}/test"))->assertStatus(202);
        }

        $this->setGuc($tenantA->id);
        foreach (['webhook_endpoints', 'webhook_secrets', 'webhook_deliveries'] as $table) {
            $tenants = array_map(fn ($r) => $r->tenant_id, DB::select("select tenant_id from {$table}"));
            $this->assertNotEmpty($tenants, $table);
            $this->assertSame([$tenantA->id], array_values(array_unique($tenants)), $table);
        }
        $this->assertNotNull($this->sqlState(fn () => DB::insert(
            "insert into webhook_endpoints (id, tenant_id, store_id, url, events, created_at, updated_at) values (?, ?, ?, 'https://x.example.com', '[]', now(), now())",
            [strtolower((string) Str::ulid()), $tenantB->id, $storeB->id],
        )));

        $this->setGuc(null);
        foreach (['webhook_endpoints', 'webhook_secrets', 'webhook_deliveries'] as $table) {
            $this->assertSame(0, (int) DB::selectOne("select count(*) as c from {$table}")->c, $table);
        }
    }
}
