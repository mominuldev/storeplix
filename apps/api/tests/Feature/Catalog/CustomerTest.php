<?php

namespace Tests\Feature\Catalog;

use App\Domain\Customers\Models\Customer;
use App\Domain\Tenancy\Models\AuditLog;
use App\Domain\Tenancy\Models\TenantUser;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Tests\Support\CatalogFixtures;
use Tests\TestCase;

class CustomerTest extends TestCase
{
    use CatalogFixtures, RefreshDatabase;

    public function test_phone_normalisation_duplicates_and_search(): void
    {
        [, , $store, $h] = $this->shop(TenantUser::ROLE_STAFF);
        $url = "/api/v1/stores/{$store->id}/customers";

        $c = $this->api($h, 'POST', $url, ['name' => 'Farhana Rahman', 'phone' => '01556-120987', 'district' => 'Narayanganj', 'channel' => 'instagram', 'tags' => ['Repeat buyer']])
            ->assertCreated()->assertJsonPath('data.phone', '8801556120987')->assertJsonPath('data.source', 'manual')
            ->assertJsonPath('data.tags', ['repeat buyer'])->assertJsonPath('data.currency', 'BDT')->assertJsonPath('data.notes', [])
            ->assertJsonPath('data.orders_count', 0)->assertJsonPath('data.revision', 1)->json('data');

        foreach (['+8801556120987', '8801556120987', '01556 120987'] as $same) {
            $this->api($h, 'POST', $url, ['name' => 'Dup', 'phone' => $same])
                ->assertStatus(422)->assertJsonPath('error.details.phone.0', 'A customer with this phone already exists.');
        }
        $this->api($h, 'POST', $url, ['name' => 'Foreign', 'phone' => '+14155550100'])
            ->assertStatus(422)->assertJsonPath('error.details.phone.0', 'Enter a Bangladeshi mobile number (01XXXXXXXXX).');
        $this->api($h, 'POST', $url, ['name' => 'Nobody'])->assertStatus(422);
        $this->api($h, 'POST', $url, ['name' => 'Rakib', 'email' => 'Rakib@Example.com'])->assertCreated()->assertJsonPath('data.email', 'rakib@example.com');
        $this->api($h, 'POST', $url, ['name' => 'Rakib 2', 'email' => 'rakib@example.COM'])
            ->assertStatus(422)->assertJsonPath('error.details.email.0', 'A customer with this email already exists.');

        foreach (['0155' => 1, '8801556' => 1, '120987' => 1, 'example' => 0, '@example' => 1, 'farh' => 1, 'zzz' => 0] as $q => $n) {
            $this->api($h, 'GET', "{$url}?q=".urlencode($q))->assertOk()->assertJsonCount($n, 'data');
        }
        $this->api($h, 'GET', "{$url}?filter[channel]=instagram")->assertJsonCount(1, 'data')
            ->assertJsonPath('meta.counts', ['all' => 2, 'new_this_month' => 2]);
        $this->api($h, 'GET', "{$url}?filter[tag]=repeat%20buyer")->assertJsonCount(1, 'data');

        // PATCH: revision; never-writable fields ignored.
        $this->api($h, 'PATCH', "{$url}/{$c['id']}", ['revision' => 5, 'name' => 'X'])->assertStatus(409)->assertJsonPath('error.code', 'revision_conflict');
        $this->api($h, 'PATCH', "{$url}/{$c['id']}", [
            'revision' => 1, 'area' => 'Fatullah', 'orders_count' => 50, 'total_spent_amount' => 999, 'source' => 'storefront', 'last_order_at' => '2026-01-01T00:00:00Z',
        ])->assertOk()->assertJsonPath('data.revision', 2)->assertJsonPath('data.area', 'Fatullah')
            ->assertJsonPath('data.orders_count', 0)->assertJsonPath('data.total_spent_amount', 0)
            ->assertJsonPath('data.source', 'manual')->assertJsonPath('data.last_order_at', null);
    }

    public function test_notes_permissions_and_delete(): void
    {
        [, $tenant, $store, $ownerH] = $this->shop();
        [, $staffAH] = $this->member($tenant, TenantUser::ROLE_STAFF);
        [, $staffBH] = $this->member($tenant, TenantUser::ROLE_STAFF);
        [, $adminH] = $this->member($tenant, TenantUser::ROLE_ADMIN);
        $url = "/api/v1/stores/{$store->id}/customers";
        $c = $this->api($staffAH, 'POST', $url, ['name' => 'A', 'phone' => '01712345678'])->json('data');

        $note = $this->api($staffAH, 'POST', "{$url}/{$c['id']}/notes", ['body' => 'Prefers evening delivery'])
            ->assertCreated()->assertJsonPath('data.can_delete', true)->json('data');
        $note2 = $this->api($staffAH, 'POST', "{$url}/{$c['id']}/notes", ['body' => 'Second'])->json('data');
        $this->api($staffAH, 'POST', "{$url}/{$c['id']}/notes", ['body' => str_repeat('x', 1001)])->assertStatus(422);

        $this->api($staffBH, 'GET', "{$url}/{$c['id']}")->assertOk()->assertJsonPath('data.notes.0.body', 'Second')
            ->assertJsonPath('data.notes.0.can_delete', false)->assertJsonPath('data.notes_count', 2);
        $this->api($staffBH, 'DELETE', "{$url}/{$c['id']}/notes/{$note['id']}")->assertForbidden();
        $this->api($staffAH, 'DELETE', "{$url}/{$c['id']}/notes/{$note['id']}")->assertNoContent();
        $this->api($adminH, 'DELETE', "{$url}/{$c['id']}/notes/{$note2['id']}")->assertNoContent();

        $this->api($staffAH, 'DELETE', "{$url}/{$c['id']}")->assertForbidden();
        $this->api($ownerH, 'DELETE', "{$url}/{$c['id']}")->assertNoContent();
        $this->api($ownerH, 'GET', "{$url}/{$c['id']}")->assertNotFound();
        $this->assertTrue(AuditLog::query()->where('action', 'customer.deleted')->exists());
        // The phone is free again.
        $this->api($ownerH, 'POST', $url, ['name' => 'A again', 'phone' => '01712345678'])->assertCreated();
        $this->assertSame(1, Customer::withoutTenancy()->where('store_id', $store->id)->count());
    }
}
