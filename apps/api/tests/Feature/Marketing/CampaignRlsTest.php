<?php

declare(strict_types=1);

namespace Tests\Feature\Marketing;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\RlsFixtures;
use Tests\TestCase;

/**
 * S119 at the database (PHASE-8-5 §7.1): campaigns, campaign_recipients, campaign_conversions and
 * marketing_suppressions are under forced RLS. With tenant A's GUC raw SQL sees none of B's rows and can't write one
 * for B; with no tenant it sees nothing. TENANCY_RLS=true on Postgres as storeplix_app only (CI api-rls).
 */
#[Group('campaigns')]
#[Group('rls')]
#[Group('security')]
class CampaignRlsTest extends TestCase
{
    use CampaignFixtures, RefreshDatabase, RlsFixtures {
        CampaignFixtures::planFor insteadof RlsFixtures;
        CampaignFixtures::liveShop insteadof RlsFixtures;
        CampaignFixtures::shop insteadof RlsFixtures;
        CampaignFixtures::member insteadof RlsFixtures;
        CampaignFixtures::api insteadof RlsFixtures;
        CampaignFixtures::simpleProduct insteadof RlsFixtures;
        CampaignFixtures::variableProduct insteadof RlsFixtures;
        CampaignFixtures::createProduct insteadof RlsFixtures;
        CampaignFixtures::productImage insteadof RlsFixtures;
        CampaignFixtures::assertStoreIsolation insteadof RlsFixtures;
        CampaignFixtures::stocked insteadof RlsFixtures;
        CampaignFixtures::host insteadof RlsFixtures;
        CampaignFixtures::sf insteadof RlsFixtures;
        CampaignFixtures::cartWith insteadof RlsFixtures;
        CampaignFixtures::checkoutBody insteadof RlsFixtures;
        CampaignFixtures::checkout insteadof RlsFixtures;
        CampaignFixtures::placeOrder insteadof RlsFixtures;
        CampaignFixtures::manualBody insteadof RlsFixtures;
        CampaignFixtures::manual insteadof RlsFixtures;
    }

    private const TABLES = ['campaigns', 'campaign_recipients', 'campaign_conversions', 'marketing_suppressions'];

    public function test_campaign_tables_are_isolated_by_row_level_security(): void
    {
        $this->requireRls();
        $this->setUpCampaigns();
        $shops = [];
        foreach (['alpha' => '01711000001', 'beta' => '01711000001'] as $slug => $phone) {
            [, $tenant, $store, $h] = $this->campaignShop(slug: $slug);
            [, $variant] = $this->stocked($h, $store, 100000, 10);
            $customer = $this->customer($h, $store, ['phone' => $phone]);
            $id = $this->createCampaign($h, $store);
            $this->sendNow($h, $store, $id)->assertStatus(202);
            $this->placeOrder($store, $variant); // attributed (same phone as the checkout contact)
            $this->api($h, 'POST', "/api/v1/stores/{$store->id}/customers/{$customer->id}/marketing-opt-out", ['channel' => 'sms'])->assertOk();
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
            "insert into marketing_suppressions (id, tenant_id, store_id, channel, address, source, created_at) values (?, ?, ?, 'sms', '8801700000000', 'merchant', now())",
            [strtolower((string) Str::ulid()), $tenantB->id, $storeB->id],
        )));

        $this->setGuc(null);
        foreach (self::TABLES as $table) {
            $this->assertSame(0, (int) DB::selectOne("select count(*) as c from {$table}")->c, $table);
        }
    }
}
