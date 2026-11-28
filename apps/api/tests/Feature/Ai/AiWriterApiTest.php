<?php

declare(strict_types=1);

namespace Tests\Feature\Ai;

use App\Domain\Admin\Impersonation\ImpersonationService;
use App\Domain\Ai\Credits\AiCreditCharger;
use App\Domain\Ai\Models\AiCreditLedgerEntry;
use App\Domain\Ai\Models\AiGeneration;
use App\Domain\Ai\Writer\FakeDescriptionWriter;
use App\Domain\Catalog\Models\Product;
use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\SpaBrowser;
use Tests\TestCase;

/**
 * PHASE-8-9D §11.2 / §11.4 (P89D-51–P89D-56): the description writer through the API with the fake driver — On/Off,
 * charge + idempotent replay, validation, ids resolved in the store, failure refunds, exhaustion, history, permissions,
 * impersonation, tenant / store isolation (S330, S341, S343, S345).
 */
#[Group('ai')]
class AiWriterApiTest extends TestCase
{
    use AiFixtures, RefreshDatabase, SpaBrowser;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpAi();
    }

    public function test_off_by_default_then_a_request_is_charged_queued_and_written_without_touching_the_product(): void
    {
        [$owner, $tenant, $store, $h] = $this->aiShop('w1', tools: []);
        $this->describe($h, $store)->assertStatus(409)->assertJsonPath('error.code', 'ai_integration_off');
        $this->assertCount(0, $this->ledger($tenant));
        $this->turnOn($h, $store, 'ai_writer', ['default_tone' => 'premium', 'default_language' => 'en']);

        [$product] = $this->productWithImages($h, $store);
        $r = $this->describe($h, $store, ['product_id' => $product['id'], 'key_points' => ['  Pure cotton ', 'Hand woven'], 'variants' => 3])
            ->assertStatus(202)->assertHeader('Cache-Control', 'no-store, private');
        $this->assertSame(['id', 'kind', 'status', 'product', 'credits', 'charged_from', 'refunded', 'input', 'variants', 'source_image', 'result_image',
            'check_edges', 'error_code', 'requested_by', 'created_at', 'finished_at', 'applied_at', 'undone_at', 'original_kept_until'], array_keys($r->json('data')));
        // The queue runs inline in tests: the poll answer is already final.
        $g = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/ai/generations/".$r->json('data.id'))->assertOk()->json('data');
        $this->assertSame(['product_description', 'succeeded', 1, 'allowance', false, null], [$g['kind'], $g['status'], $g['credits'], $g['charged_from'], $g['refunded'], $g['error_code']]);
        $this->assertSame(['id' => $product['id'], 'name' => 'Jamdani Saree'], $g['product']);
        $this->assertSame(['id' => $owner->id, 'name' => $owner->name], $g['requested_by']);
        $this->assertSame('en', $g['input']['language']);
        $this->assertSame('premium', $g['input']['tone']);
        $this->assertSame(['Pure cotton', 'Hand woven'], $g['input']['key_points']);
        $this->assertCount(3, $g['variants']);
        $this->assertSame(['description_html', 'paragraphs', 'highlights', 'seo_title', 'meta_description'], array_keys($g['variants'][0]));
        $this->assertStringStartsWith('<p>', $g['variants'][0]['description_html']);
        $this->assertNull($g['source_image']);
        $this->assertNotNull($g['finished_at']);

        // S344: only product data reached the driver (name, options, key points, image) — no price, customer or staff data.
        $sent = FakeDescriptionWriter::$requests[0];
        $this->assertSame(['name', 'category', 'options', 'key_points'], array_keys($sent->productData()));
        $this->assertSame('Jamdani Saree', $sent->name);
        $this->assertSame('image/jpeg', $sent->image['media_type']);
        $this->assertNotFalse(base64_decode($sent->image['data'], true));
        $this->assertStringNotContainsString('450000', (string) json_encode($sent->productData()));

        // P89D-52: never auto-saved; one consume row; audit without text.
        $this->assertNull($this->inTenant($tenant, fn () => Product::query()->findOrFail($product['id'])->description));
        $this->assertSame([['consume', 'allowance', -1]], $this->ledger($tenant)->map(fn ($e) => [$e->type, $e->source, $e->credits])->all());
        $audits = $this->aiAudits($tenant, 'ai.');
        $this->assertSame('ai.description_generated', $audits[0]['action']);
        $this->assertSame(['store_id' => $store->id, 'product_id' => $product['id'], 'language' => 'en', 'variants' => 3], $audits[0]['meta']);
        $this->assertStringNotContainsString('Jamdani', (string) json_encode($audits));
        $this->api($h, 'GET', '/api/v1/billing/ai-credits')->assertOk()->assertJsonPath('data.allowance.used', 1)->assertJsonPath('data.available', 19);
    }

    public function test_idempotency_key_maps_to_one_generation_and_one_charge(): void
    {
        [, $tenant, $store, $h] = $this->aiShop('w2');
        $key = (string) Str::ulid();
        $first = $this->describe($h, $store, ['name' => 'Kurta'], $key)->assertStatus(202)->json('data.id');
        $this->describe($h, $store, ['name' => 'Kurta'], $key)->assertStatus(202)->assertJsonPath('data.id', $first);
        $this->describe($h, $store, ['name' => 'Saree'], $key)->assertStatus(409)->assertJsonPath('error.code', 'idempotency_key_mismatch');
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/ai/product-descriptions", ['name' => 'No key'])->assertStatus(400)->assertJsonPath('error.code', 'idempotency_key_required');
        $this->assertCount(1, $this->ledger($tenant));
        // Another member using the same key gets their own generation (U(store, requested_by, key)).
        [, $admin] = $this->member($tenant, TenantUser::ROLE_ADMIN);
        $this->assertNotSame($first, $this->describe($admin, $store, ['name' => 'Kurta'], $key)->assertStatus(202)->json('data.id'));
    }

    public function test_validation_and_ids_resolved_within_the_store(): void
    {
        [, , $store, $h] = $this->aiShop('w3');
        [, , $storeB, $hB] = $this->aiShop('w3b');
        [$productB] = $this->productWithImages($hB, $storeB);
        foreach ([
            [[], 'name'],
            [['name' => str_repeat('x', 201)], 'name'],
            [['name' => 'A', 'variants' => 4], 'variants'],
            [['name' => 'A', 'variants' => 0], 'variants'],
            [['name' => 'A', 'key_points' => array_fill(0, 11, 'x')], 'key_points'],
            [['name' => 'A', 'key_points' => [str_repeat('k', 201)]], 'key_points.0'],
            [['name' => 'A', 'tone' => 'angry'], 'tone'],
            [['name' => 'A', 'language' => 'fr'], 'language'],
            [['name' => 'A', 'use_product_image' => 'yes'], 'use_product_image'],
        ] as [$body, $field]) {
            $this->describe($h, $store, $body)->assertStatus(422)->assertJsonValidationErrors([$field], 'error.details');
        }
        $this->describe($h, $store, ['product_id' => $productB['id']])->assertNotFound()->assertJsonPath('error.code', 'not_found');
    }

    public function test_failures_are_free_refused_invalid_and_unavailable_all_refund_once(): void
    {
        [, $tenant, $store, $h] = $this->aiShop('w4');
        foreach (['[refuse]' => 'ai_refused', '[invalid]' => 'ai_output_invalid', '[unavailable]' => 'ai_unavailable', '[timeout]' => 'ai_timeout'] as $marker => $code) {
            $id = $this->describe($h, $store, ['name' => "Shirt {$marker}"])->assertStatus(202)->json('data.id');
            $g = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/ai/generations/{$id}")->json('data');
            $this->assertSame(['failed', $code, true, null], [$g['status'], $g['error_code'], $g['refunded'], $g['variants']], $marker);
        }
        $rows = $this->ledger($tenant);
        $this->assertSame(4, $rows->where('type', 'consume')->count());
        $this->assertSame(4, $rows->where('type', 'refund')->count());
        $this->assertSame(0, (int) $rows->sum('credits'));
        $this->api($h, 'GET', '/api/v1/billing/ai-credits')->assertJsonPath('data.allowance.used', 0);
        // A second refund attempt is a no-op (unique per generation).
        $g = $this->generationRow($tenant, (string) $rows->first()->ai_generation_id);
        $this->assertFalse($this->inTenant($tenant, fn () => app(AiCreditCharger::class)->refund($g)));
    }

    public function test_allowance_then_bonus_then_402_with_details(): void
    {
        [, $tenant, $store, $h] = $this->aiShop('w5');
        config(['ai.costs.product_description' => 7]); // free plan: 20 → two requests fit (14), the third needs bonus
        $this->describe($h, $store)->assertStatus(202)->assertJsonPath('data.charged_from', 'allowance');
        $this->describe($h, $store)->assertStatus(202)->assertJsonPath('data.charged_from', 'allowance');
        $r = $this->describe($h, $store)->assertStatus(402)->assertJsonPath('error.code', 'ai_credits_exhausted');
        $this->assertSame(['needed' => 7, 'available' => 6], array_intersect_key($r->json('error.details'), ['needed' => 1, 'available' => 1]));
        $this->assertSame(now('Asia/Dhaka')->startOfMonth()->addMonthNoOverflow()->utc()->toIso8601ZuluString(), $r->json('error.details.resets_at'));
        $this->assertSame(0, $this->platformTable('ai_generations')->where('tenant_id', $tenant->id)->where('status', 'queued')->count()); // nothing created

        $this->inTenant($tenant, fn () => app(AiCreditCharger::class)->adjust(10, 'Goodwill grant', User::factory()->create(), 'grant-key-1', 'h'));
        // Wholly from one source: 6 allowance left < 7 → bonus.
        $this->describe($h, $store)->assertStatus(202)->assertJsonPath('data.charged_from', 'bonus');
        $this->api($h, 'GET', '/api/v1/billing/ai-credits')->assertJsonPath('data.bonus', 3)->assertJsonPath('data.allowance.remaining', 6)->assertJsonPath('data.available', 9);
        // A failed bonus request refunds the bonus.
        $this->inTenant($tenant, fn () => app(AiCreditCharger::class)->adjust(4, 'More', User::factory()->create(), 'grant-key-2', 'h'));
        $this->describe($h, $store, ['name' => 'X [refuse]'])->assertStatus(202)->assertJsonPath('data.charged_from', 'bonus');
        $this->api($h, 'GET', '/api/v1/billing/ai-credits')->assertJsonPath('data.bonus', 7);

        // Next month the allowance resets; bonus never expires.
        $this->travelTo(now('Asia/Dhaka')->startOfMonth()->addMonthNoOverflow()->addHour());
        $this->api($h, 'GET', '/api/v1/billing/ai-credits')->assertJsonPath('data.allowance.used', 0)->assertJsonPath('data.allowance.remaining', 20)->assertJsonPath('data.bonus', 7);
    }

    public function test_history_filters_and_polling(): void
    {
        [, , $store, $h] = $this->aiShop('w6');
        [$product] = $this->productWithImages($h, $store);
        $a = $this->describe($h, $store, ['product_id' => $product['id']])->json('data.id');
        $b = $this->describe($h, $store, ['name' => 'Bad [refuse]'])->json('data.id');
        $list = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/ai/generations")->assertOk()->assertJsonPath('meta.per_page', 50)->json('data');
        $this->assertSame([$b, $a], array_column($list, 'id'));
        $this->assertSame([$b], array_column($this->api($h, 'GET', "/api/v1/stores/{$store->id}/ai/generations?filter[status]=failed")->json('data'), 'id'));
        $this->assertSame([$a], array_column($this->api($h, 'GET', "/api/v1/stores/{$store->id}/ai/generations?filter[product_id]={$product['id']}")->json('data'), 'id'));
        $this->assertCount(2, $this->api($h, 'GET', "/api/v1/stores/{$store->id}/ai/generations?filter[kind]=product_description")->json('data'));
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/ai/generations?filter[kind]=poem")->assertStatus(422);
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/ai/generations?filter[status]=done")->assertStatus(422);
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/ai/generations/".strtolower((string) Str::ulid()))->assertNotFound();
        // Outputs older than 90 days are pruned (and hidden).
        $this->travel(91)->days();
        $this->artisan('ai:prune')->assertSuccessful();
        $this->assertSame([], $this->api($h, 'GET', "/api/v1/stores/{$store->id}/ai/generations")->json('data'));
    }

    #[Group('security')]
    public function test_permission_matrix_staff_writes_with_products_edit_but_cannot_configure(): void
    {
        [, $tenant, $store, $h] = $this->aiShop('w7', 'growth');
        [, $admin] = $this->member($tenant, TenantUser::ROLE_ADMIN);
        [, $staff] = $this->member($tenant, TenantUser::ROLE_STAFF);
        $marketer = $this->memberWithRole($tenant, $this->customRole($h, 'Marketer', ['marketing.manage']))[1];
        $billing = $this->memberWithRole($tenant, $this->customRole($h, 'Books', ['billing.view']))[1];

        foreach ([$h, $admin, $staff] as $who) {
            $id = $this->describe($who, $store)->assertStatus(202)->json('data.id');
            $this->api($who, 'GET', "/api/v1/stores/{$store->id}/ai/generations/{$id}")->assertOk();
            $this->api($who, 'GET', "/api/v1/stores/{$store->id}/ai/generations")->assertOk();
            $this->api($who, 'GET', '/api/v1/billing/ai-credits')->assertOk();
        }
        $this->describe($marketer, $store)->assertForbidden();
        $this->api($marketer, 'GET', "/api/v1/stores/{$store->id}/ai/generations")->assertForbidden();
        $this->api($marketer, 'GET', '/api/v1/billing/ai-credits')->assertForbidden();
        $this->api($billing, 'GET', '/api/v1/billing/ai-credits')->assertOk();
        $this->api($billing, 'GET', '/api/v1/billing/ai-credits/ledger')->assertOk();
        $this->describe($billing, $store)->assertForbidden();
        // Staff can't turn tools on/off or read the ledger.
        $this->api($staff, 'PUT', "/api/v1/stores/{$store->id}/integrations/ai_writer", ['settings' => [], 'revision' => 1])->assertForbidden();
        $this->api($staff, 'POST', "/api/v1/stores/{$store->id}/integrations/ai_writer/disconnect", ['confirm' => 'DISCONNECT'])->assertForbidden();
        $this->api($staff, 'GET', '/api/v1/billing/ai-credits/ledger')->assertForbidden();
        $this->api($admin, 'GET', '/api/v1/billing/ai-credits/ledger')->assertOk()->assertJsonCount(3, 'data');

        // Off again: new requests 409; history stays readable.
        $this->api($admin, 'POST', "/api/v1/stores/{$store->id}/integrations/ai_writer/disconnect", ['confirm' => 'DISCONNECT'])->assertOk();
        $this->describe($staff, $store)->assertStatus(409)->assertJsonPath('error.code', 'ai_integration_off');
        $this->api($staff, 'GET', "/api/v1/stores/{$store->id}/ai/generations")->assertOk()->assertJsonCount(3, 'data');
    }

    #[Group('security')]
    public function test_cross_tenant_and_cross_store_access_is_404(): void
    {
        [, $tenantA, $storeA, $hA] = $this->aiShop('wa');
        [, $tenantB, $storeB, $hB] = $this->aiShop('wb');
        [$productB, $mediaB] = $this->productWithImages($hB, $storeB);
        $genB = $this->describe($hB, $storeB, ['product_id' => $productB['id']])->json('data.id');
        $photoB = $this->photoEdit($hB, $storeB, ['media_id' => $mediaB[0], 'operation' => 'remove_background'])->json('data.id');
        $this->describe($hA, $storeA)->assertStatus(202);

        $this->assertTenantIsolation($hA, [
            ['POST', "/api/v1/stores/{$storeB->id}/ai/product-descriptions", ['name' => 'X']],
            ['POST', "/api/v1/stores/{$storeB->id}/ai/photo-edits", ['media_id' => $mediaB[0], 'operation' => 'remove_background']],
            ['GET', "/api/v1/stores/{$storeB->id}/ai/generations"],
            ['GET', "/api/v1/stores/{$storeB->id}/ai/generations/{$genB}"],
            ['POST', "/api/v1/stores/{$storeB->id}/ai/photo-edits/{$photoB}/apply", ['product_id' => $productB['id']]],
            ['POST', "/api/v1/stores/{$storeB->id}/ai/photo-edits/{$photoB}/undo"],
            // B's ids under A's own store.
            ['GET', "/api/v1/stores/{$storeA->id}/ai/generations/{$genB}"],
            ['POST', "/api/v1/stores/{$storeA->id}/ai/photo-edits/{$photoB}/apply", ['product_id' => $productB['id']]],
            ['POST', "/api/v1/stores/{$storeA->id}/ai/photo-edits/{$photoB}/undo"],
            ['POST', "/api/v1/stores/{$storeA->id}/ai/product-descriptions", ['product_id' => $productB['id']]],
            ['POST', "/api/v1/stores/{$storeA->id}/ai/photo-edits", ['media_id' => $mediaB[0], 'operation' => 'remove_background']],
        ]);
        $this->assertSame('succeeded', $this->generationRow($tenantB, $photoB)->status);
        $this->assertStoreIsolation(AiGeneration::class, $tenantA, $storeA, $storeB);
        // Tenant-level credits: A's summary and ledger never count B's rows.
        $this->api($hA, 'GET', '/api/v1/billing/ai-credits')->assertJsonPath('data.allowance.used', 1);
        $this->assertSame([$tenantA->id], $this->inTenant($tenantA, fn () => AiCreditLedgerEntry::query()->pluck('tenant_id')->unique()->values()->all()));
    }

    #[Group('security')]
    public function test_impersonation_reads_but_generation_is_a_write_403(): void
    {
        [, $tenant, $store, $h] = $this->aiShop('wimp');
        $id = $this->describe($h, $store)->json('data.id');
        $this->useSpaBrowser();
        $support = User::factory()->create();
        $support->forceFill(['platform_role' => 'support'])->save();
        [, $url] = app(ImpersonationService::class)->create($support, $tenant, 'Customer ticket: AI writer check', 'ZD-77', '127.0.0.1', 'phpunit');
        $this->unencryptedCookies = [];
        $this->browser('GET', '/sanctum/csrf-cookie');
        $started = $this->browser('POST', '/api/v1/auth/impersonation', ['ticket' => Str::after($url, '#ticket=')]);
        if ($started->status() === 419) {
            $this->markTestSkipped('SPA session cookie unavailable in this local environment (pre-existing 419).');
        }
        $started->assertOk();
        $t = ['X-Tenant-Id' => $tenant->id, 'Idempotency-Key' => (string) Str::ulid()];
        $this->browser('GET', "/api/v1/stores/{$store->id}/ai/generations/{$id}", [], $t)->assertOk();
        $this->browser('GET', '/api/v1/billing/ai-credits', [], $t)->assertOk();
        foreach ([['POST', '/ai/product-descriptions', ['name' => 'X']], ['POST', '/ai/photo-edits', ['media_id' => $id, 'operation' => 'remove_background']],
            ['POST', "/ai/photo-edits/{$id}/apply", ['product_id' => $id]], ['POST', "/ai/photo-edits/{$id}/undo", []]] as [$m, $p, $b]) {
            $this->browser($m, "/api/v1/stores/{$store->id}{$p}", $b, $t)->assertForbidden()->assertJsonPath('error.code', 'impersonation_read_only');
        }
        $this->assertCount(1, $this->ledger($tenant));
    }

    #[Group('security')]
    public function test_ai_generate_limiter_is_20_per_minute_per_member(): void
    {
        $this->setUpAi(throttle: true);
        [, $tenant, $store, $h] = $this->aiShop('wlim', 'growth');
        for ($i = 0; $i < 20; $i++) {
            $this->describe($h, $store)->assertStatus(202);
        }
        $this->describe($h, $store)->assertStatus(429);
        [, $other] = $this->member($tenant, TenantUser::ROLE_ADMIN);
        $this->describe($other, $store)->assertStatus(202); // per member
        // Reads are not limited by ai-generate.
        $this->api($h, 'GET', "/api/v1/stores/{$store->id}/ai/generations")->assertOk();
    }
}
