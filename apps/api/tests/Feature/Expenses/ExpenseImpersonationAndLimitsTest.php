<?php

declare(strict_types=1);

namespace Tests\Feature\Expenses;

use App\Domain\Admin\Impersonation\ImpersonationService;
use App\Domain\Identity\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\SpaBrowser;
use Tests\TestCase;

/** S142 (impersonation: amounts readable, writes and receipts refused, CSV readable + audited) and S152 (limiters). */
#[Group('expenses')]
#[Group('security')]
class ExpenseImpersonationAndLimitsTest extends TestCase
{
    use ExpenseFixtures, RefreshDatabase, SpaBrowser;

    public function test_impersonation_reads_amounts_but_not_receipts_and_cannot_write(): void
    {
        $this->setUpExpenses();
        [, $tenant, $store, $h] = $this->shop();
        $e = $this->addExpense($h, $store, ['receipt_id' => $this->pdfReceipt($h, $store)]);

        $this->useSpaBrowser();
        Mail::fake();
        $staff = User::factory()->create();
        $staff->forceFill(['platform_role' => 'support'])->save();
        [, $url] = app(ImpersonationService::class)->create($staff, $tenant, 'Customer ticket: expenses check', 'ZD-87', '127.0.0.1', 'phpunit');
        $this->unencryptedCookies = [];
        $this->browser('GET', '/sanctum/csrf-cookie');
        $this->browser('POST', '/api/v1/auth/impersonation', ['ticket' => Str::after($url, '#ticket=')])->assertOk();
        $t = ['X-Tenant-Id' => $tenant->id];

        $this->browser('GET', $this->eUrl($store), [], $t)->assertOk()->assertJsonPath('data.0.amount', 10000);
        $this->browser('GET', $this->eUrl($store, '/summary'), [], $t)->assertOk();
        $this->browser('GET', $this->eUrl($store, "/{$e['id']}/receipt"), [], $t)->assertForbidden()
            ->assertJsonPath('error.code', 'impersonation_receipt_hidden');
        $this->browser('GET', $this->eUrl($store, '/export'), [], $t)->assertOk();
        $this->browser('POST', $this->eUrl($store), ['amount' => 1, 'category' => 'ads', 'paid_from' => 'cash', 'spent_on' => '2026-11-20'], $t)
            ->assertForbidden()->assertJsonPath('error.code', 'impersonation_read_only');
        $this->browser('PATCH', $this->eUrl($store, "/{$e['id']}"), ['amount' => 1], $t)->assertForbidden();
        $this->browser('DELETE', $this->eUrl($store, "/{$e['id']}"), [], $t)->assertForbidden();
        $this->assertSame(10000, $this->expenseRow($tenant, $e['id'])->amount);

        $exported = $this->platformTable('audit_logs')->where('tenant_id', $tenant->id)->where('action', 'expense.exported')->first();
        $this->assertSame('platform_user', $exported->actor_type);
    }

    public function test_limiters(): void
    {
        $this->setUpExpenses(throttle: true);
        [, , $store, $h] = $this->shop();
        $body = ['amount' => 1, 'category' => 'other', 'paid_from' => 'cash', 'spent_on' => '2026-11-20'];
        for ($i = 0; $i < 60; $i++) {
            $this->api($h, 'POST', $this->eUrl($store), $body)->assertCreated();
        }
        $this->api($h, 'POST', $this->eUrl($store), $body)->assertTooManyRequests();

        for ($i = 0; $i < 20; $i++) {
            $this->upload($h, $store, 'r.pdf', self::pdf())->assertCreated();
        }
        $this->upload($h, $store, 'r.pdf', self::pdf())->assertTooManyRequests();

        $this->travel(2)->minutes();
        $e = $this->addExpense($h, $store, ['receipt_id' => $this->pdfReceipt($h, $store)]);
        $link = $this->api($h, 'GET', $this->eUrl($store, "/{$e['id']}/receipt"))->assertOk()->json('data.url');
        for ($i = 0; $i < 60; $i++) {
            $this->flushHeaders()->get($link)->assertOk();
        }
        $this->flushHeaders()->get($link)->assertTooManyRequests();
    }
}
