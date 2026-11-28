<?php

declare(strict_types=1);

namespace Tests\Feature\Ai;

use App\Domain\Ai\Models\AiCreditLedgerEntry;
use App\Domain\Ai\Models\AiGeneration;
use App\Domain\Ai\Writer\FakeDescriptionWriter;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Http\UploadedFile;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Collection;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Support\CommerceFixtures;
use Tests\Support\RoleFixtures;

/**
 * Phase 8.9d part B AI helpers: a shop with the writer / photos turned on, generation requests with an Idempotency-Key,
 * products with a real (processed) image, raw ledger / generation rows through the platform connection.
 */
trait AiFixtures
{
    use CommerceFixtures, RoleFixtures;

    protected function setUpAi(bool $throttle = false): void
    {
        $throttle ? $this->withMiddleware(ThrottleRequests::class) : $this->withoutMiddleware(ThrottleRequests::class);
        Mail::fake();
        Storage::fake('public');
        Storage::fake('local');
        config(['ai.driver' => 'fake', 'ai.image_driver' => 'fake']);
        FakeDescriptionWriter::$requests = [];
    }

    /** @return array{0: mixed, 1: Tenant, 2: Store, 3: array<string, string>} */
    protected function aiShop(string $slug = 'ai', string $plan = 'free', array $tools = ['ai_writer', 'ai_photos']): array
    {
        [$user, $tenant, $store, $h] = $this->liveShop($slug);
        $this->planFor($tenant, $plan);
        foreach ($tools as $tool) {
            $this->turnOn($h, $store, $tool);
        }

        return [$user, $tenant, $store, $h];
    }

    protected function turnOn(array $h, Store $store, string $tool, array $settings = []): TestResponse
    {
        $defaults = $tool === 'ai_writer'
            ? ['default_language' => 'bn', 'default_tone' => 'friendly', 'default_length' => 'medium', 'use_product_image' => true]
            : ['default_background' => 'studio_white'];

        return $this->api($h, 'PUT', "/api/v1/stores/{$store->id}/integrations/{$tool}", ['settings' => $settings + $defaults])->assertOk();
    }

    /** @param array<string, mixed> $body */
    protected function describe(array $h, Store $store, array $body = ['name' => 'Cotton Panjabi'], ?string $key = null): TestResponse
    {
        return $this->api($h + ['Idempotency-Key' => $key ?? (string) Str::ulid()], 'POST', "/api/v1/stores/{$store->id}/ai/product-descriptions", $body);
    }

    /** @param array<string, mixed> $body */
    protected function photoEdit(array $h, Store $store, array $body, ?string $key = null): TestResponse
    {
        return $this->api($h + ['Idempotency-Key' => $key ?? (string) Str::ulid()], 'POST', "/api/v1/stores/{$store->id}/ai/photo-edits", $body);
    }

    /** An active product with one (or more) 400×400 images. @return array{0: array<string, mixed>, 1: list<string>} product, media ids */
    protected function productWithImages(array $h, Store $store, int $images = 1): array
    {
        $media = [];
        for ($i = 0; $i < $images; $i++) {
            $media[] = $this->flushHeaders()->withHeaders($h)->post('/api/v1/media', [
                'file' => UploadedFile::fake()->createWithContent("p{$i}.png", $this->imageBytes(400, 400)),
                'purpose' => 'product_image',
            ], ['Accept' => 'application/json'])->assertCreated()->json('data.id');
        }
        $product = $this->createProduct($h, $store, $this->simpleProduct('Jamdani Saree', 450000, [
            'status' => 'active', 'images' => array_map(fn ($id) => ['media_id' => $id], $media),
        ]));

        return [$product, $media];
    }

    /** @return Collection<int, AiCreditLedgerEntry> */
    protected function ledger(Tenant $tenant): Collection
    {
        return $this->platformQuery(AiCreditLedgerEntry::class)->where('tenant_id', $tenant->id)->orderBy('created_at')->orderBy('id')->get();
    }

    protected function generationRow(Tenant $tenant, string $id): ?AiGeneration
    {
        return $this->platformQuery(AiGeneration::class)->where('tenant_id', $tenant->id)->whereKey($id)->first();
    }

    /** @return list<array{action: string, meta: array<string, mixed>}> */
    protected function aiAudits(Tenant $tenant, string $prefix = 'ai'): array
    {
        return $this->platformQuery(AuditLog::class)->where('tenant_id', $tenant->id)->where('action', 'like', $prefix.'%')->orderBy('id')->get()
            ->map(fn (AuditLog $a) => ['action' => $a->action, 'meta' => (array) $a->meta])->all();
    }

    /**
     * Cross-tenant / cross-store resource access: every URL → 404 not_found.
     *
     * @param  list<array{0: string, 1: string, 2?: array<string, mixed>}>  $requests
     */
    protected function assertTenantIsolation(array $headersA, array $requests): void
    {
        foreach ($requests as $request) {
            $this->flushHeaders()->withHeaders($headersA + ['Idempotency-Key' => (string) Str::ulid()])->json($request[0], $request[1], $request[2] ?? [])
                ->assertNotFound()->assertJsonPath('error.code', 'not_found');
        }
    }
}
