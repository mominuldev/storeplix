<?php

namespace Tests\Feature\Media;

use App\Domain\Media\Jobs\ProcessMedia;
use App\Domain\Media\Models\Media;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Queue;
use Illuminate\Support\Facades\Storage;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

class MediaTest extends TestCase
{
    use RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        Storage::fake('public');
    }

    private function upload(array $headers, UploadedFile $file, string $purpose = 'logo')
    {
        return $this->flushHeaders()->withHeaders($headers)->post('/api/v1/media', ['file' => $file, 'purpose' => $purpose, 'alt' => 'Logo'], ['Accept' => 'application/json']);
    }

    public function test_logo_upload_is_processed_into_variants_under_tenant_path(): void
    {
        [$user, $tenant] = $this->merchant(TenantUser::ROLE_STAFF);
        $file = UploadedFile::fake()->createWithContent('logo.png', $this->imageBytes(800, 400));

        $response = $this->upload($this->tenantHeaders($user, $tenant), $file)
            ->assertCreated()
            ->assertJsonPath('data.status', 'ready') // sync queue in tests
            ->assertJsonPath('data.mime', 'image/png')
            ->assertJsonPath('data.width', 800)
            ->assertJsonPath('data.alt', 'Logo')
            ->assertJsonCount(3, 'data.variants')
            ->assertJsonPath('data.variants.1.key', 'w320')
            ->assertJsonPath('data.variants.1.mime', 'image/webp')
            ->assertJsonPath('data.variants.1.height', 160);

        $media = Media::withoutTenancy()->sole();
        $this->assertSame("tenants/{$tenant->id}/media/{$media->id}/original.png", $media->path);
        Storage::disk('public')->assertExists($media->path);
        Storage::disk('public')->assertExists("tenants/{$tenant->id}/media/{$media->id}/w640.webp");
        $this->assertStringStartsWith('http://', $response->json('data.url'));
        $this->assertStringContainsString("/storage/tenants/{$tenant->id}/media/", $response->json('data.variants.0.url'));
    }

    public function test_upload_is_queued_on_media_queue_and_starts_processing(): void
    {
        Queue::fake();
        [$user, $tenant] = $this->merchant();

        $this->upload($this->tenantHeaders($user, $tenant), UploadedFile::fake()->createWithContent('a.jpg', $this->imageBytes(300, 300, 'jpeg')), 'product_image')
            ->assertCreated()->assertJsonPath('data.status', 'processing')->assertJsonPath('data.variants', []);

        Queue::assertPushedOn('media', ProcessMedia::class, fn (ProcessMedia $job) => $job->mediaId === Media::withoutTenancy()->value('id'));
    }

    #[Group('tenancy')]
    public function test_spoofed_mime_type_is_rejected(): void
    {
        [$user, $tenant] = $this->merchant();
        $headers = $this->tenantHeaders($user, $tenant);

        $cases = [
            UploadedFile::fake()->createWithContent('logo.png', "<?php echo 'pwned'; ?>"),             // script named .png
            UploadedFile::fake()->createWithContent('logo.png', $this->imageBytes(200, 200, 'gif')),  // GIF renamed
            UploadedFile::fake()->createWithContent('logo.png', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'),
            UploadedFile::fake()->createWithContent('logo.png', "\x89PNG\r\n\x1a\n".str_repeat('A', 200)), // PNG magic, garbage body
        ];

        foreach ($cases as $file) {
            $this->upload($headers, $file)
                ->assertStatus(422)
                ->assertJsonPath('error.code', 'validation_failed')
                ->assertJsonStructure(['error' => ['details' => ['file']]]);
        }

        // Favicons are PNG only — a real JPEG is rejected too.
        $this->upload($headers, UploadedFile::fake()->createWithContent('f.png', $this->imageBytes(64, 64, 'jpeg')), 'favicon')
            ->assertStatus(422);

        $this->assertSame(0, Media::withoutTenancy()->count());
        $this->assertSame([], Storage::disk('public')->allFiles());
    }

    public function test_size_and_dimension_rules(): void
    {
        [$user, $tenant] = $this->merchant();
        $headers = $this->tenantHeaders($user, $tenant);

        $this->upload($headers, UploadedFile::fake()->createWithContent('s.png', $this->imageBytes(32, 32)))
            ->assertStatus(422)->assertJsonPath('error.details.file.0', 'Each side must be between 64 and 4096 px.');
        $this->upload($headers, UploadedFile::fake()->createWithContent('f.png', $this->imageBytes(128, 100)), 'favicon')
            ->assertStatus(422)->assertJsonPath('error.details.file.0', 'The favicon must be square.');

        $big = UploadedFile::fake()->createWithContent('big.png', $this->imageBytes(100, 100).str_repeat("\0", 2 * 1024 * 1024));
        $this->upload($headers, $big)->assertStatus(422)->assertJsonPath('error.details.file.0', 'The file may not be larger than 2 MB.');
    }

    public function test_favicon_variants_are_never_upscaled(): void
    {
        [$user, $tenant] = $this->merchant();

        $this->upload($this->tenantHeaders($user, $tenant), UploadedFile::fake()->createWithContent('f.png', $this->imageBytes(200, 200)), 'favicon')
            ->assertCreated()
            ->assertJsonPath('data.status', 'ready')
            ->assertJsonPath('data.variants.*.key', ['favicon_32', 'apple_180', 'icon_192']);
    }

    #[Group('tenancy')]
    public function test_another_tenant_cannot_see_or_delete_your_media(): void
    {
        [$userA, $tenantA] = $this->merchant();
        [$userB, $tenantB] = $this->merchant();

        $id = $this->upload($this->tenantHeaders($userA, $tenantA), UploadedFile::fake()->createWithContent('l.png', $this->imageBytes(100, 100)))
            ->json('data.id');

        $headersB = $this->tenantHeaders($userB, $tenantB);
        $this->flushHeaders()->withHeaders($headersB)->getJson("/api/v1/media/{$id}")->assertNotFound()->assertJsonPath('error.code', 'not_found');
        $this->withHeaders($headersB)->deleteJson("/api/v1/media/{$id}")->assertNotFound();

        $this->flushHeaders()->withHeaders($this->tenantHeaders($userB, $tenantA))->getJson("/api/v1/media/{$id}")->assertForbidden();

        $this->assertSame(1, Media::withoutTenancy()->count());
    }

    #[Group('tenancy')]
    public function test_delete_rules_in_use_and_roles(): void
    {
        [$owner, $tenant] = $this->merchant();
        [$staff] = $this->merchant(TenantUser::ROLE_STAFF, $tenant);
        $store = $this->storeFor($tenant, 'shop');
        $ownerHeaders = $this->tenantHeaders($owner, $tenant);
        $staffHeaders = $this->tenantHeaders($staff, $tenant);

        $logo = $this->upload($ownerHeaders, UploadedFile::fake()->createWithContent('l.png', $this->imageBytes(100, 100)))->json('data.id');
        $product = $this->upload($staffHeaders, UploadedFile::fake()->createWithContent('p.png', $this->imageBytes(300, 300)), 'product_image')->json('data.id');

        $this->flushHeaders()->withHeaders($ownerHeaders)->patchJson("/api/v1/stores/{$store->id}/settings", ['branding' => ['logo_media_id' => $logo]])->assertOk();

        $this->withHeaders($ownerHeaders)->deleteJson("/api/v1/media/{$logo}")->assertStatus(409)->assertJsonPath('error.code', 'media_in_use');
        $this->flushHeaders()->withHeaders($staffHeaders)->deleteJson("/api/v1/media/{$logo}")->assertForbidden();
        $this->withHeaders($staffHeaders)->deleteJson("/api/v1/media/{$product}")->assertNoContent();

        Storage::disk('public')->assertMissing("tenants/{$tenant->id}/media/{$product}/original.png");
        $this->assertTrue($this->platformQuery(AuditLog::class)->where('action', 'media.deleted')->where('subject_id', $product)->exists());
    }
}
