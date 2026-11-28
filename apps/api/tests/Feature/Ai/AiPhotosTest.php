<?php

declare(strict_types=1);

namespace Tests\Feature\Ai;

use App\Domain\Ai\AiGenerationService;
use App\Domain\Catalog\Models\ProductImage;
use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Media\Models\Media;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-9D §11.3 (P89D-39, P89D-57, P89D-58, S346): AI product photos with the fake image driver — presets only, the
 * source must be this store's product image, private results behind a signed link, Save to product (in place or
 * appended), Undo while the original is kept, no refund on undo, pruning; "Coming soon" in production.
 */
#[Group('ai')]
class AiPhotosTest extends TestCase
{
    use AiFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpAi();
    }

    public function test_edit_charges_two_credits_and_keeps_the_result_private_until_saved(): void
    {
        [, $tenant, $store, $h] = $this->aiShop('p1');
        [$product, $media] = $this->productWithImages($h, $store);
        $r = $this->photoEdit($h, $store, ['media_id' => $media[0], 'product_id' => $product['id'], 'operation' => 'replace_background', 'background' => 'mint'])
            ->assertStatus(202)->assertJsonPath('data.kind', 'photo_edit')->assertJsonPath('data.credits', 2);
        $g = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/ai/generations/".$r->json('data.id'))->json('data');
        $this->assertSame(['succeeded', 'allowance', null], [$g['status'], $g['charged_from'], $g['variants']]);
        $this->assertSame(['media_id' => $media[0], 'product_id' => $product['id'], 'operation' => 'replace_background', 'background' => 'mint'], $g['input']);
        $this->assertSame($media[0], $g['source_image']['id']);
        $this->assertNotEmpty($g['source_image']['srcset']);
        $this->assertSame([400, 400, []], [$g['result_image']['width'], $g['result_image']['height'], $g['result_image']['srcset']]);
        $this->assertIsBool($g['check_edges']);
        $this->assertSame([['consume', -2]], $this->ledger($tenant)->map(fn ($e) => [$e->type, $e->credits])->all());

        // The result is an `ai_photo` on the PRIVATE disk under the tenant prefix, never in the media library.
        $result = $this->inTenant($tenant, fn () => Media::query()->findOrFail($g['result_image']['id']));
        $this->assertSame(['ai_photo', 'local'], [$result->purpose, $result->disk]);
        $this->assertStringStartsWith("tenants/{$tenant->id}/media/", $result->path);
        Storage::disk('local')->assertExists($result->path);
        $this->assertNotContains($result->id, array_column($this->api($h, 'GET', '/api/v1/media')->json('data'), 'id'));
        $this->api($h, 'GET', "/api/v1/media/{$result->id}")->assertNotFound();

        // Signed link works without a session; tampered or unsigned → 403; another tenant's signature → 404.
        $url = (string) $g['result_image']['url'];
        $path = parse_url($url, PHP_URL_PATH).'?'.parse_url($url, PHP_URL_QUERY);
        $this->flushHeaders()->get($path)->assertOk()->assertHeader('Content-Type', 'image/jpeg')->assertHeader('X-Content-Type-Options', 'nosniff');
        $this->flushHeaders()->get(parse_url($url, PHP_URL_PATH))->assertForbidden();
        $this->flushHeaders()->get(str_replace('signature=', 'signature=0', $path))->assertForbidden();
        // Transparent background → PNG.
        $png = $this->photoEdit($h, $store, ['media_id' => $media[0], 'operation' => 'remove_background'])->assertStatus(202)->assertJsonPath('data.input.background', 'transparent');
        $this->assertSame('image/png', $this->inTenant($tenant, fn () => Media::query()->findOrFail($png->json('data.result_image.id'))->mime));
    }

    public function test_presets_only_and_the_source_must_be_a_product_image_of_this_store(): void
    {
        [, , $store, $h] = $this->aiShop('p2');
        [, , $storeB, $hB] = $this->aiShop('p2b');
        [$product, $media] = $this->productWithImages($h, $store);
        [, $mediaB] = $this->productWithImages($hB, $storeB);
        foreach ([
            [['media_id' => $media[0], 'operation' => 'replace_background'], 'background'],
            [['media_id' => $media[0], 'operation' => 'replace_background', 'background' => 'neon'], 'background'],
            [['media_id' => $media[0], 'operation' => 'replace_background', 'background' => 'a sunny beach at dusk'], 'background'],
            [['media_id' => $media[0], 'operation' => 'redraw'], 'operation'],
            [['operation' => 'remove_background'], 'media_id'],
        ] as [$body, $field]) {
            $this->photoEdit($h, $store, $body)->assertStatus(422)->assertJsonValidationErrors([$field], 'error.details');
        }
        $this->photoEdit($h, $store, ['media_id' => $mediaB[0], 'operation' => 'remove_background'])->assertNotFound();
        $this->photoEdit($h, $store, ['media_id' => $media[0], 'product_id' => strtolower((string) Str::ulid()), 'operation' => 'remove_background'])->assertNotFound();
        // A library image that isn't on a product, a logo → 404.
        $loose = $this->productImage($h);
        $this->photoEdit($h, $store, ['media_id' => $loose, 'operation' => 'remove_background'])->assertNotFound();
        // A product image under 300 px → 422 image_unsupported (nothing charged).
        $small = $this->flushHeaders()->withHeaders($h)->post('/api/v1/media', [
            'file' => UploadedFile::fake()->createWithContent('s.png', $this->imageBytes(250, 250)), 'purpose' => 'product_image',
        ], ['Accept' => 'application/json'])->assertCreated()->json('data.id');
        $this->createProduct($h, $store, $this->simpleProduct('Small', 1000, ['images' => [['media_id' => $small]]]));
        $this->photoEdit($h, $store, ['media_id' => $small, 'operation' => 'remove_background'])->assertStatus(422)->assertJsonPath('error.code', 'image_unsupported');
        $this->api($h, 'GET', '/api/v1/billing/ai-credits')->assertJsonPath('data.allowance.used', 0);
        unset($product);
    }

    public function test_save_in_place_then_undo_restores_the_original_without_refund(): void
    {
        [, $tenant, $store, $h] = $this->aiShop('p3');
        [$product, $media] = $this->productWithImages($h, $store, 2);
        $this->inTenant($tenant, fn () => ProductVariant::query()->where('product_id', $product['id'])->update(['image_media_id' => $media[1]]));
        $id = $this->photoEdit($h, $store, ['media_id' => $media[1], 'operation' => 'replace_background', 'background' => 'soft_grey'])->json('data.id');
        $resultId = $this->api($h, 'GET', "/api/v1/stores/{$store->id}/ai/generations/{$id}")->json('data.result_image.id');
        $apply = "/api/v1/stores/{$store->id}/ai/photo-edits/{$id}/apply";
        $undo = "/api/v1/stores/{$store->id}/ai/photo-edits/{$id}/undo";

        $this->api($h, 'POST', $undo)->assertStatus(409)->assertJsonPath('error.code', 'ai_generation_not_applicable');
        $this->api($h, 'POST', $apply, [])->assertStatus(422);
        $this->api($h, 'POST', $apply, ['product_id' => $product['id'], 'replace_image_id' => strtolower((string) Str::ulid())])->assertStatus(422)->assertJsonValidationErrors(['replace_image_id'], 'error.details');
        $g = $this->api($h, 'POST', $apply, ['product_id' => $product['id'], 'replace_image_id' => $media[1]])->assertOk()->json('data');
        $this->assertSame('applied', $g['status']);
        $this->assertNotNull($g['applied_at']);
        $this->assertEqualsWithDelta(now()->addDays(30)->getTimestamp(), strtotime($g['original_kept_until']), 5);
        // Same position, the variant follows, the result is now a normal product image with variants.
        $images = $this->inTenant($tenant, fn () => ProductImage::query()->where('product_id', $product['id'])->orderBy('position')->pluck('media_id')->all());
        $this->assertSame([$media[0], $resultId], $images);
        $this->assertSame($resultId, $this->inTenant($tenant, fn () => ProductVariant::query()->where('product_id', $product['id'])->value('image_media_id')));
        $result = $this->inTenant($tenant, fn () => Media::query()->findOrFail($resultId));
        $this->assertSame(['product_image', 'public', 'ready'], [$result->purpose, $result->disk, $result->status]);
        $this->assertNotEmpty($result->variants);
        Storage::disk('public')->assertExists($result->path);
        Storage::disk('local')->assertMissing($result->path);
        $this->assertNotEmpty($g['result_image']['srcset']);
        $this->api($h, 'POST', $apply, ['product_id' => $product['id']])->assertStatus(409); // twice → not applicable

        $u = $this->api($h, 'POST', $undo)->assertOk()->json('data');
        $this->assertSame('undone', $u['status']);
        $this->assertSame([$media[0], $media[1]], $this->inTenant($tenant, fn () => ProductImage::query()->where('product_id', $product['id'])->orderBy('position')->pluck('media_id')->all()));
        $this->assertSame($media[1], $this->inTenant($tenant, fn () => ProductVariant::query()->where('product_id', $product['id'])->value('image_media_id')));
        $this->api($h, 'POST', $undo)->assertStatus(409);
        $this->assertSame(['consume'], $this->ledger($tenant)->pluck('type')->all()); // no refund on undo
        $this->assertSame(['ai.photo_applied', 'ai.photo_undone'], array_column($this->aiAudits($tenant, 'ai.photo'), 'action'));
    }

    public function test_append_when_no_image_is_replaced_and_undo_removes_it(): void
    {
        [, $tenant, $store, $h] = $this->aiShop('p4');
        [$product, $media] = $this->productWithImages($h, $store);
        [$other] = $this->productWithImages($h, $store);
        $id = $this->photoEdit($h, $store, ['media_id' => $media[0], 'operation' => 'remove_background'])->json('data.id');
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/ai/photo-edits/{$id}/apply", ['product_id' => strtolower((string) Str::ulid())])->assertNotFound();
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/ai/photo-edits/{$id}/apply", ['product_id' => $other['id']])->assertOk()->assertJsonPath('data.original_kept_until', null)
            ->assertJsonPath('data.product.id', $other['id']);
        $this->assertCount(2, $this->inTenant($tenant, fn () => ProductImage::query()->where('product_id', $other['id'])->get()));
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/ai/photo-edits/{$id}/undo")->assertOk();
        $this->assertCount(1, $this->inTenant($tenant, fn () => ProductImage::query()->where('product_id', $other['id'])->get()));
        // A description generation is never "applicable".
        $d = $this->describe($h, $store)->json('data.id');
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/ai/photo-edits/{$d}/apply", ['product_id' => $product['id']])->assertStatus(409);
    }

    public function test_prune_removes_unapplied_results_and_unused_originals_on_schedule(): void
    {
        [, $tenant, $store, $h] = $this->aiShop('p5');
        [$product, $media] = $this->productWithImages($h, $store, 2);
        $unapplied = $this->photoEdit($h, $store, ['media_id' => $media[0], 'operation' => 'remove_background'])->json('data');
        $applied = $this->photoEdit($h, $store, ['media_id' => $media[1], 'operation' => 'remove_background'])->json('data.id');
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/ai/photo-edits/{$applied}/apply", ['product_id' => $product['id'], 'replace_image_id' => $media[1]])->assertOk();
        $unappliedPath = $this->inTenant($tenant, fn () => Media::query()->findOrFail($unapplied['result_image']['id'])->path);

        $this->travel(8)->days();
        $this->artisan('ai:prune')->assertSuccessful();
        $this->assertNull($this->inTenant($tenant, fn () => Media::query()->find($unapplied['result_image']['id'])));
        Storage::disk('local')->assertMissing($unappliedPath);
        $this->assertNotNull($this->inTenant($tenant, fn () => Media::query()->find($media[1]))); // original still kept for undo

        $this->travel(23)->days();
        $this->artisan('ai:prune')->assertSuccessful();
        $this->assertNull($this->inTenant($tenant, fn () => Media::query()->find($media[1])));
        $this->assertNotNull($this->inTenant($tenant, fn () => Media::query()->find($media[0]))); // still used by the product
        $this->api($h, 'POST', "/api/v1/stores/{$store->id}/ai/photo-edits/{$applied}/undo")->assertStatus(409);
    }

    public function test_coming_soon_in_production_and_staff_can_edit_but_not_configure(): void
    {
        [, $tenant, $store, $h] = $this->aiShop('p6', 'free', ['ai_writer']);
        [, $staff] = $this->member($tenant, TenantUser::ROLE_STAFF);
        [, $media] = $this->productWithImages($h, $store);
        $this->photoEdit($h, $store, ['media_id' => $media[0], 'operation' => 'remove_background'])->assertStatus(409)->assertJsonPath('error.code', 'ai_integration_off');

        $this->app['env'] = 'production';
        try {
            $this->assertFalse(AiGenerationService::photosAvailable());
            $this->api($h, 'PUT', "/api/v1/stores/{$store->id}/integrations/ai_photos", ['settings' => ['default_background' => 'mint']])
                ->assertStatus(422)->assertJsonPath('error.code', 'integration_setup_required');
        } finally {
            $this->app['env'] = 'testing';
        }
        $this->turnOn($h, $store, 'ai_photos');
        $this->photoEdit($staff, $store, ['media_id' => $media[0], 'operation' => 'remove_background'])->assertStatus(202);
        $this->api($staff, 'PATCH', "/api/v1/stores/{$store->id}/integrations/ai_photos", ['settings' => ['default_background' => 'mint'], 'revision' => 1])->assertForbidden();
        config(['ai.image_driver' => 'remove_bg']);
        $this->photoEdit($h, $store, ['media_id' => $media[0], 'operation' => 'remove_background'])->assertStatus(409);
    }
}
