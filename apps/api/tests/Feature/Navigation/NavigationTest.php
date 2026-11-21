<?php

namespace Tests\Feature\Navigation;

use App\Domain\Navigation\Models\StoreNavigation;
use App\Domain\Stores\Revalidation\RevalidateStorefront;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Queue;
use Tests\Support\StorefrontContent;
use Tests\TestCase;

class NavigationTest extends TestCase
{
    use RefreshDatabase, StorefrontContent;

    private function item(string $id, string $label, array $link, ?array $children = null): array
    {
        return array_filter(['id' => $id, 'label' => $label, 'link' => $link, 'children' => $children], fn ($v) => $v !== null);
    }

    public function test_defaults_and_lazy_creation(): void
    {
        [$user, $tenant] = $this->merchant(TenantUser::ROLE_STAFF);
        $store = $this->storeFor($tenant, 'shop');
        $headers = $this->tenantHeaders($user, $tenant);

        $menus = $this->withHeaders($headers)->getJson("/api/v1/stores/{$store->id}/navigation")
            ->assertOk()
            ->assertJsonCount(3, 'data')
            ->assertJsonPath('data.0.handle', 'main')
            ->assertJsonPath('data.0.title', 'Main menu')
            ->assertJsonPath('data.1.title', 'Shop')
            ->assertJsonPath('data.2.handle', 'help')
            ->assertJsonStructure(['data' => ['*' => ['id', 'handle', 'title', 'items', 'revision', 'updated_at']]])
            ->json('data');

        $this->assertSame(['Home', 'About us'], array_column($menus[0]['items'], 'label'));
        $this->assertSame(['/', '/pages/about'], array_column($menus[0]['items'], 'href'));
        $this->assertSame('About us', $menus[0]['items'][1]['page_title']);
        $this->assertSame(['Contact', 'Delivery & return policy', 'Privacy policy', 'Terms of service'], array_column($menus[2]['items'], 'label'));
        $this->assertSame(['ok', 'page_unpublished', 'page_unpublished', 'page_unpublished'], array_column($menus[2]['items'], 'link_status'));

        // A store without menu rows gets them lazily.
        $this->tenancy()->run($tenant, fn () => StoreNavigation::query()->delete());
        $this->withHeaders($headers)->getJson("/api/v1/stores/{$store->id}/navigation")->assertOk()->assertJsonCount(3, 'data');
        $this->assertSame(3, StoreNavigation::withoutTenancy()->where('store_id', $store->id)->count());
    }

    public function test_save_menu_resolves_links_and_revalidates(): void
    {
        [$user, $tenant] = $this->merchant(TenantUser::ROLE_ADMIN);
        $store = $this->storeFor($tenant, 'shop');
        $headers = $this->tenantHeaders($user, $tenant);
        $pages = collect($this->withHeaders($headers)->getJson("/api/v1/stores/{$store->id}/pages")->json('data'))->keyBy('slug');
        Queue::fake();

        $items = [
            $this->item('home000001', 'Home', ['type' => 'home']),
            $this->item('shop000001', ' Shop ', ['type' => 'collection', 'handle' => 'winter-sale'], [
                $this->item('kids000001', 'Kids', ['type' => 'collection', 'handle' => 'kids']),
                $this->item('priv000001', 'Privacy', ['type' => 'page', 'page_id' => $pages['privacy']['id']]),
            ]),
            $this->item('ext0000001', 'Blog', ['type' => 'url', 'url' => 'http://blog.example.com/a?b=c']),
            $this->item('trak000001', 'Track', ['type' => 'builtin', 'target' => 'track_order']),
        ];

        $this->withHeaders($headers)->putJson("/api/v1/stores/{$store->id}/navigation/main", ['title' => 'Header', 'items' => $items, 'revision' => 1])
            ->assertOk()
            ->assertJsonPath('data.title', 'Header')
            ->assertJsonPath('data.revision', 2)
            ->assertJsonPath('data.items.1.label', 'Shop')
            ->assertJsonPath('data.items.1.href', '/collections/winter-sale')
            ->assertJsonPath('data.items.1.children.1.link_status', 'page_unpublished')
            ->assertJsonPath('data.items.1.children.1.href', '/pages/privacy')
            ->assertJsonPath('data.items.2.href', 'http://blog.example.com/a?b=c')
            ->assertJsonPath('data.items.3.href', '/track-order');
        Queue::assertPushed(RevalidateStorefront::class);
        $this->assertSame(['handle' => 'main'], AuditLog::query()->where('action', 'navigation.updated')->first()->meta);

        // Stale revision → 409; unknown handle → 404.
        $this->withHeaders($headers)->putJson("/api/v1/stores/{$store->id}/navigation/main", ['items' => [], 'revision' => 1])
            ->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');
        $this->withHeaders($headers)->putJson("/api/v1/stores/{$store->id}/navigation/mobile", ['items' => [], 'revision' => 1])->assertNotFound();

        // The resolved fields the dashboard reads back are accepted (and ignored) on save.
        $resolved = $this->withHeaders($headers)->getJson("/api/v1/stores/{$store->id}/navigation")->json('data.0.items');
        $this->withHeaders($headers)->putJson("/api/v1/stores/{$store->id}/navigation/main", ['items' => $resolved, 'revision' => 2])->assertOk();
    }

    public function test_structure_rules(): void
    {
        [$user, $tenant] = $this->merchant();
        $store = $this->storeFor($tenant, 'shop');
        $headers = $this->tenantHeaders($user, $tenant);
        $url = "/api/v1/stores/{$store->id}/navigation/footer";
        $home = fn (string $id) => $this->item($id, 'Home', ['type' => 'home']);

        $deep = [$home('aaaaaaaa00'), $home('aaaaaaaa01'), $home('aaaaaaaa02'), $this->item('aaaaaaaa03', 'L1', ['type' => 'home'], [
            $this->item('aaaaaaaa04', 'L2', ['type' => 'home'], [$home('aaaaaaaa05')]),
        ])];
        $this->withHeaders($headers)->putJson($url, ['items' => $deep, 'revision' => 1])
            ->assertStatus(422)->assertJsonPath('error.details', ['items.3.children.0.children' => ['Menus can only be two levels deep.']]);

        $ids = fn (int $n, string $p) => array_map(fn ($i) => $home($p.str_pad((string) $i, 6, '0', STR_PAD_LEFT)), range(1, $n));
        $this->withHeaders($headers)->putJson($url, ['items' => $ids(21, 'top'), 'revision' => 1])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['items']]]);
        $wide = [$this->item('parent0001', 'P', ['type' => 'home'], $ids(21, 'kid'))];
        $this->withHeaders($headers)->putJson($url, ['items' => $wide, 'revision' => 1])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['items.0.children']]]);
        $many = array_map(fn ($i) => $this->item("par{$i}000000", 'P', ['type' => 'home'], $ids(3, "c{$i}x")), range(1, 16)); // 16 + 48 = 64
        $this->withHeaders($headers)->putJson($url, ['items' => $many, 'revision' => 1])->assertStatus(422)->assertJsonStructure(['error' => ['details' => ['items']]]);

        $bad = [
            'items.0.id' => [$this->item('BAD', 'x', ['type' => 'home'])],
            'items.1.id' => [$home('dupe000001'), $home('dupe000001')],
            'items.0.label' => [$this->item('aaaaaaaa01', str_repeat('x', 41), ['type' => 'home'])],
            'items.0.link.type' => [$this->item('aaaaaaaa01', 'x', ['type' => 'landing'])],
            'items.0.link.handle' => [$this->item('aaaaaaaa01', 'x', ['type' => 'collection', 'handle' => 'Bad Handle'])],
            'items.0.link.target' => [$this->item('aaaaaaaa01', 'x', ['type' => 'builtin', 'target' => 'admin'])],
            'items.0.link.page_id' => [$this->item('aaaaaaaa01', 'x', ['type' => 'page', 'page_id' => '01jzzzzzzzzzzzzzzzzzzzzzzz'])],
            'items.0.style' => [$this->item('aaaaaaaa01', 'x', ['type' => 'home']) + ['style' => 'x']],
        ];
        foreach ($bad as $path => $items) {
            $this->withHeaders($headers)->putJson($url, ['items' => $items, 'revision' => 1])
                ->assertStatus(422)->assertJsonStructure(['error' => ['details' => [$path]]]);
        }
    }
}
