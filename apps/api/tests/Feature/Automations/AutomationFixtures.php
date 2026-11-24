<?php

declare(strict_types=1);

namespace Tests\Feature\Automations;

use App\Domain\Automations\Models\Automation;
use App\Domain\Automations\Models\AutomationRun;
use App\Domain\Automations\Models\AutomationRunStep;
use App\Domain\Payments\Models\PaymentGatewayAccount;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Support\Collection;
use Illuminate\Testing\TestResponse;
use Tests\Feature\Marketing\CampaignFixtures;

/**
 * Phase 8.6 helpers on top of the 8.5 fixtures (live Starter shop at noon Dhaka, fake SMS gateway, array mailer):
 * automations created + enabled through the API, orders driven to delivered / returned, the storefront contact call.
 */
trait AutomationFixtures
{
    use CampaignFixtures;

    protected function aUrl(Store $store, string $suffix = ''): string
    {
        return "/api/v1/stores/{$store->id}/automations".$suffix;
    }

    /** Creates the recipe's automation (draft); returns its detail. @return array<string, mixed> */
    protected function createAutomation(array $h, Store $store, string $recipe): array
    {
        return $this->api($h, 'POST', $this->aUrl($store), ['recipe' => $recipe])->assertCreated()->json('data');
    }

    /** Creates, patches settings (optional, merged over the defaults) and enables. @param array<string, mixed> $settings @return array<string, mixed> */
    protected function automationOn(array $h, Store $store, string $recipe, array $settings = []): array
    {
        $a = $this->createAutomation($h, $store, $recipe);
        if ($settings !== []) {
            $a = $this->api($h, 'PATCH', $this->aUrl($store, "/{$a['id']}"), ['settings' => array_replace_recursive((array) $a['settings'], $settings), 'revision' => $a['revision']])
                ->assertOk()->json('data');
        }

        return $this->api($h, 'POST', $this->aUrl($store, "/{$a['id']}/enable"))->assertOk()->json('data');
    }

    /** A manual order driven to delivered; returns the order payload. @return array<string, mixed> */
    protected function deliveredOrder(array $h, Store $store, string $variant, array $override = []): array
    {
        $order = $this->manual($h, $store, $this->manualBody($variant, 1, ['notify_customer' => false] + $override))->assertCreated()->json('data');
        foreach (['confirm', 'ship', 'deliver'] as $step) {
            $this->api($h, 'POST', "/api/v1/stores/{$store->id}/orders/{$order['id']}/{$step}", ['notify_customer' => false] + ($step === 'ship' ? ['carrier_name' => 'Pathao'] : []))->assertOk();
        }

        return $order;
    }

    /** @return Collection<int, AutomationRun> */
    protected function runsOf(Tenant $tenant, ?string $automationId = null): Collection
    {
        return $this->platformQuery(AutomationRun::class)->where('tenant_id', $tenant->id)
            ->when($automationId !== null, fn ($q) => $q->where('automation_id', $automationId))->orderBy('created_at')->orderBy('id')->get();
    }

    /** @return Collection<int, AutomationRunStep> */
    protected function stepsOf(Tenant $tenant, string $runId): Collection
    {
        return $this->platformQuery(AutomationRunStep::class)->where('tenant_id', $tenant->id)->where('run_id', $runId)->orderBy('step_index')->get();
    }

    protected function automationRow(Tenant $tenant, string $id): Automation
    {
        return $this->platformQuery(Automation::class)->where('tenant_id', $tenant->id)->whereKey($id)->firstOrFail();
    }

    /** A cart with one line and the checkout contact saved; returns the cart token. */
    protected function contactCart(Store $store, string $variant, string $phone = '01711000001', array $extra = []): string
    {
        $cart = $this->cartWith($store, $variant);
        $this->sf($store, 'PUT', '/cart/contact', ['phone' => $phone] + $extra, $cart)->assertNoContent();

        return $cart;
    }

    protected function detect(?int $delay = null): void
    {
        $this->artisan('automations:detect-abandoned', array_filter(['--sync' => true, '--delay' => $delay], fn ($v) => $v !== null))->assertSuccessful();
    }

    protected function resumeDue(): void
    {
        $this->artisan('automations:resume-due', ['--sync' => true])->assertSuccessful();
    }

    protected function recover(Store $store, string $code, array $extra = []): TestResponse
    {
        return $this->sf($store, 'POST', '/carts/recover', ['code' => $code], null, $extra);
    }

    /** Extracts the cart-restore code from a rendered message. */
    protected function cartCodeIn(string $text): string
    {
        preg_match('~/r/([A-Za-z0-9]{10})~', $text, $m);

        return $m[1] ?? '';
    }

    /** Connects a fake bKash account (inside the tenant) so online checkout holds the order. */
    protected function connectFakeBkash(Tenant $tenant, Store $store): void
    {
        config(['payments.fake' => true]);
        $this->inTenant($tenant, function () use ($store) {
            $a = new PaymentGatewayAccount;
            $a->store_id = $store->id;
            $a->provider = 'bkash';
            $a->mode = 'sandbox';
            $a->status = 'connected';
            $a->enabled = true;
            $a->credentials = ['app_key' => 'appkey-3f9a', 'app_secret' => 'secret', 'username' => 'user', 'password' => 'pass'];
            $a->route_key = PaymentGatewayAccount::newRouteKey();
            $a->save();
        });
    }
}
