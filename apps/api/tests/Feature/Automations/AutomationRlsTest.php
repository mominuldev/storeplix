<?php

declare(strict_types=1);

namespace Tests\Feature\Automations;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\RlsFixtures;
use Tests\TestCase;

/**
 * S130 at the database (PHASE-8-6 §4.4): automations, automation_runs, automation_run_steps and automation_conversions
 * are under forced RLS. With tenant A's GUC raw SQL sees none of B's rows and can't write one for B; with no tenant it
 * sees nothing. Also: audit_logs accepts actor_type `automation` (P86-20). TENANCY_RLS=true on Postgres only.
 */
#[Group('automations')]
#[Group('rls')]
#[Group('security')]
class AutomationRlsTest extends TestCase
{
    use AutomationFixtures, RefreshDatabase, RlsFixtures {
        AutomationFixtures::planFor insteadof RlsFixtures;
        AutomationFixtures::liveShop insteadof RlsFixtures;
        AutomationFixtures::shop insteadof RlsFixtures;
        AutomationFixtures::member insteadof RlsFixtures;
        AutomationFixtures::api insteadof RlsFixtures;
        AutomationFixtures::simpleProduct insteadof RlsFixtures;
        AutomationFixtures::variableProduct insteadof RlsFixtures;
        AutomationFixtures::createProduct insteadof RlsFixtures;
        AutomationFixtures::productImage insteadof RlsFixtures;
        AutomationFixtures::assertStoreIsolation insteadof RlsFixtures;
        AutomationFixtures::stocked insteadof RlsFixtures;
        AutomationFixtures::host insteadof RlsFixtures;
        AutomationFixtures::sf insteadof RlsFixtures;
        AutomationFixtures::cartWith insteadof RlsFixtures;
        AutomationFixtures::checkoutBody insteadof RlsFixtures;
        AutomationFixtures::checkout insteadof RlsFixtures;
        AutomationFixtures::placeOrder insteadof RlsFixtures;
        AutomationFixtures::manualBody insteadof RlsFixtures;
        AutomationFixtures::manual insteadof RlsFixtures;
    }

    private const TABLES = ['automations', 'automation_runs', 'automation_run_steps', 'automation_conversions'];

    public function test_automation_tables_are_isolated_by_row_level_security(): void
    {
        $this->requireRls();
        $this->setUpCampaigns();
        $shops = [];
        foreach (['alpha', 'beta'] as $slug) {
            [, $tenant, $store, $h] = $this->campaignShop(slug: $slug);
            [, $variant] = $this->stocked($h, $store);
            $this->automationOn($h, $store, 'checkout_recovery', ['step1' => ['message' => ['language' => 'en', 'body' => 'Hi {cart_link}']]]);
            $cart = $this->contactCart($store, $variant);
            $this->travel(31)->minutes();
            $this->detect();
            $code = $this->cartCodeIn((string) end($this->sms()->sent)['text']);
            $token = $this->recover($store, $code)->assertCreated()->json('data.cart_token');
            $total = $this->sf($store, 'GET', '/cart', [], $token)->json('data.estimated_total_amount');
            $this->checkout($store, $token, $this->checkoutBody($total + 7000))->assertCreated(); // converted + conversion
            $this->assertNotNull($cart);
            $this->travel(-31)->minutes();
            $shops[$slug] = [$tenant, $store];
        }
        [$tenantA] = $shops['alpha'];
        [$tenantB, $storeB] = $shops['beta'];

        $this->setGuc($tenantA->id);
        foreach (self::TABLES as $table) {
            $tenants = array_map(fn ($r) => trim((string) $r->tenant_id), DB::select("select tenant_id from {$table}"));
            $this->assertNotEmpty($tenants, $table);
            $this->assertSame([$tenantA->id], array_values(array_unique($tenants)), $table);
        }
        $this->assertNotNull($this->sqlState(fn () => DB::insert(
            "insert into automations (id, tenant_id, store_id, recipe, name, status, settings, revision, created_at, updated_at) values (?, ?, ?, 'thank_you', 'x', 'draft', '{}', 1, now(), now())",
            [strtolower((string) Str::ulid()), $tenantB->id, $storeB->id],
        )));
        // P86-20: the automation actor type is allowed by the CHECK constraint.
        DB::insert("insert into audit_logs (id, tenant_id, actor_type, actor_id, action, created_at) values (?, ?, 'automation', ?, 'automation.updated', now())",
            [strtolower((string) Str::ulid()), $tenantA->id, strtolower((string) Str::ulid())]);

        $this->setGuc(null);
        foreach (self::TABLES as $table) {
            $this->assertSame(0, (int) DB::selectOne("select count(*) as c from {$table}")->c, $table);
        }
    }
}
