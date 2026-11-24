<?php

declare(strict_types=1);

namespace Tests\Feature\Stores;

use App\Domain\Stores\Services\StoreSettingsUpdater;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use PHPUnit\Framework\Attributes\Group;
use Tests\Feature\Expenses\ExpenseFixtures;
use Tests\TestCase;

/** PHASE-8-7 §6.4 (P87-18, Q183), S153: the store currency locks once the store has an order (any status) or an expense. */
#[Group('expenses')]
#[Group('security')]
class StoreCurrencyLockTest extends TestCase
{
    use ExpenseFixtures, RefreshDatabase;

    protected function setUp(): void
    {
        parent::setUp();
        $this->setUpExpenses();
    }

    private function settingsUrl($store): string
    {
        return "/api/v1/stores/{$store->id}/settings";
    }

    private function currencyOf($tenant, $store): string
    {
        return (string) $this->inTenant($tenant, fn () => DB::table('stores')->where('id', $store->id)->value('currency'));
    }

    public function test_a_store_with_neither_can_change_its_currency(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        $this->api($h, 'GET', $this->settingsUrl($store))->assertOk()->assertJsonPath('data.region.currency_locked', false);
        $this->api($h, 'PATCH', $this->settingsUrl($store), ['region' => ['currency' => 'USD']])->assertOk()
            ->assertJsonPath('data.region.currency', 'USD')->assertJsonPath('data.region.currency_locked', false);
        $this->assertSame('USD', $this->currencyOf($tenant, $store));
    }

    public function test_an_order_of_any_status_locks_it(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        $this->order($tenant, $store, ['status' => 'cancelled', 'placed_at' => '2026-11-01 10:00:00', 'total' => 1000]);
        $this->api($h, 'GET', $this->settingsUrl($store))->assertOk()->assertJsonPath('data.region.currency_locked', true);
        $this->api($h, 'PATCH', $this->settingsUrl($store), ['region' => ['currency' => 'USD']])->assertStatus(409)
            ->assertJsonPath('error.code', 'currency_locked')->assertJsonPath('error.message', StoreSettingsUpdater::CURRENCY_LOCKED);
        $this->assertSame('BDT', $this->currencyOf($tenant, $store));
        // The same currency (and other fields in the same request) still saves.
        $this->api($h, 'PATCH', $this->settingsUrl($store), ['region' => ['currency' => 'BDT'], 'identity' => ['name' => 'Renamed']])->assertOk()
            ->assertJsonPath('data.identity.name', 'Renamed')->assertJsonPath('data.region.currency_locked', true);
    }

    public function test_an_expense_locks_it_and_expenses_take_the_store_currency(): void
    {
        [, $tenant, $store, $h] = $this->shop();
        [, $tenantB, $storeB, $hB] = $this->shop(slug: 'beta');
        $this->addExpense($h, $store);
        $this->api($h, 'GET', $this->settingsUrl($store))->assertOk()->assertJsonPath('data.region.currency_locked', true);
        $this->api($h, 'PATCH', $this->settingsUrl($store), ['region' => ['currency' => 'USD']])->assertStatus(409)->assertJsonPath('error.code', 'currency_locked');
        $this->assertSame('BDT', $this->currencyOf($tenant, $store));

        // Another tenant's rows never lock this one; a USD store records USD expenses.
        $this->api($hB, 'GET', $this->settingsUrl($storeB))->assertOk()->assertJsonPath('data.region.currency_locked', false);
        $this->api($hB, 'PATCH', $this->settingsUrl($storeB), ['region' => ['currency' => 'USD']])->assertOk();
        $this->assertSame('USD', $this->addExpense($hB, $storeB)['currency']);
        $this->api($hB, 'POST', $this->eUrl($storeB), ['amount' => 1, 'category' => 'ads', 'paid_from' => 'cash', 'spent_on' => '2026-11-20', 'currency' => 'BDT'])
            ->assertUnprocessable()->assertJsonValidationErrorFor('currency', 'error.details');
        $this->api($hB, 'PATCH', $this->settingsUrl($storeB), ['region' => ['currency' => 'BDT']])->assertStatus(409);
        $this->assertSame([], array_values(array_filter(
            $this->expensesOf($tenantB)->pluck('currency')->all(), fn ($c) => $c !== $this->currencyOf($tenantB, $storeB),
        )));
    }
}
