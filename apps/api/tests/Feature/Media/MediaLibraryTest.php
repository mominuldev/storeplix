<?php

namespace Tests\Feature\Media;

use App\Domain\Media\Models\Media;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\Support\StorefrontContent;
use Tests\TestCase;

class MediaLibraryTest extends TestCase
{
    use RefreshDatabase, StorefrontContent;

    public function test_list_is_newest_first_filtered_and_paginated(): void
    {
        Storage::fake('public');
        [$user, $tenant] = $this->merchant(TenantUser::ROLE_STAFF);
        $first = $this->uploadMedia($user, $tenant, 'page_image');
        $this->travel(1)->seconds();
        $logo = $this->uploadMedia($user, $tenant, 'logo', 200);
        $this->travel(1)->seconds();
        $failed = $this->uploadMedia($user, $tenant, 'page_image');
        $this->tenancy()->run($tenant, fn () => Media::query()->whereKey($failed)->update(['status' => Media::FAILED]));
        $headers = $this->tenantHeaders($user, $tenant);

        $this->flushHeaders()->withHeaders($headers)->getJson('/api/v1/media')
            ->assertOk()
            ->assertJsonPath('data.*.id', [$logo, $first])
            ->assertJsonPath('meta', ['current_page' => 1, 'per_page' => 24, 'total' => 2, 'last_page' => 1]);
        $this->withHeaders($headers)->getJson('/api/v1/media?filter[purpose]=page_image')->assertJsonPath('data.*.id', [$first]);
        $this->withHeaders($headers)->getJson('/api/v1/media?filter[purpose]=page_image,logo&per_page=1&page=2')
            ->assertJsonPath('data.*.id', [$first])->assertJsonPath('meta.last_page', 2);

        $this->withHeaders($headers)->getJson('/api/v1/media?filter[purpose]=video')->assertStatus(422);
        $this->withHeaders($headers)->getJson('/api/v1/media?filter[status]=ready')->assertStatus(422);
        $this->withHeaders($headers)->getJson('/api/v1/media?per_page=61')->assertStatus(422);
    }

    public function test_media_referenced_by_theme_page_or_seo_cannot_be_deleted(): void
    {
        Storage::fake('public');
        [$user, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'shop');
        $headers = $this->tenantHeaders($user, $tenant);
        [$inTheme, $inPage, $inSeo, $inPageSeo, $free] = array_map(fn () => $this->uploadMedia($user, $tenant), range(1, 5));

        $config = $this->defaultConfig();
        $config['sections'][0]['settings']['imageMediaId'] = $inTheme;
        $this->saveDraft($headers, $store, $config, 1)->assertOk();
        $this->flushHeaders()->withHeaders($headers)->postJson("/api/v1/stores/{$store->id}/pages", [
            'title' => 'Gallery', 'body' => [['id' => 'img0000001', 'type' => 'image', 'media_id' => $inPage]],
            'seo' => ['share_image_media_id' => $inPageSeo],
        ])->assertCreated();
        $this->withHeaders($headers)->patchJson("/api/v1/stores/{$store->id}/settings", ['seo' => ['share_image_media_id' => $inSeo]])->assertOk();

        foreach ([$inTheme, $inPage, $inSeo, $inPageSeo] as $id) {
            $this->withHeaders($headers)->deleteJson("/api/v1/media/{$id}")->assertStatus(409)->assertJsonPath('error.code', 'media_in_use');
        }
        $this->withHeaders($headers)->deleteJson("/api/v1/media/{$free}")->assertNoContent();
    }
}
