<?php

declare(strict_types=1);

namespace Tests\Feature\Admin\Billing;

use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Admin\Suspension\Mail\AdminNoticeMail;
use App\Domain\Billing\Mail\BillingMail;
use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Billing\Ops\MarkInvoicePaid;
use App\Domain\Billing\Ops\OpsActor;
use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Models\AuditLog;
use Illuminate\Database\Eloquent\ModelNotFoundException;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\BillingFixtures;
use Tests\Support\PlatformStaffFixtures;
use Tests\TestCase;

/** PHASE-8-1 §6.3 / §4.3 (P8-13 – P8-15, S76, S78): admin billing actions = the Phase 7 ops Actions as the tenant. */
#[Group('admin')]
class AdminBillingTest extends TestCase
{
    use BillingFixtures, PlatformStaffFixtures, RefreshDatabase;

    private User $staff;

    protected function setUp(): void
    {
        parent::setUp();
        Mail::fake();
        $this->freezeSecond();
        $this->staff = $this->staffUser(PlatformRole::Billing);
    }

    /** @param array<string, mixed> $body */
    private function admin(string $method, string $uri, array $body = [], array $headers = [], ?User $as = null): TestResponse
    {
        return $this->flushHeaders()->asAdminSurface()->withHeaders($this->adminHeaders($as ?? $this->staff) + $headers)
            ->json($method, '/api/v1/admin/'.$uri, $body);
    }

    private function auditRow(string $tenantId, string $action): ?AuditLog
    {
        return $this->platformQuery(AuditLog::class)->where('tenant_id', $tenantId)->where('action', $action)->latest('created_at')->first();
    }

    private function assertStaffAudit(string $tenantId, string $action, string $reason): void
    {
        $row = $this->auditRow($tenantId, $action);
        $this->assertNotNull($row, "missing audit {$action}");
        $this->assertSame('platform_user', $row->actor_type);
        $this->assertSame($this->staff->id, $row->actor_id);
        $this->assertSame($reason, $row->meta['reason'] ?? null);
        $this->assertSame('billing', $row->meta['platform_role'] ?? null);
    }

    public function test_change_plan_now_is_a_comp_change_with_idempotency_and_notice(): void
    {
        [, $tenant, , $h] = $this->shop();
        $open = $this->changePlan($h, 'starter')->assertCreated()->json('data.invoice.id');
        $body = ['plan_code' => 'growth', 'interval' => 'month', 'effective' => 'now', 'reason' => 'Partner deal', 'notify' => true];

        $this->admin('POST', "tenants/{$tenant->id}/billing/change-plan", $body)->assertStatus(400)->assertJsonPath('error.code', 'idempotency_key_required');
        $this->admin('POST', "tenants/{$tenant->id}/billing/change-plan", ['reason' => ''] + $body, ['Idempotency-Key' => 'key-0000001'])
            ->assertStatus(422)->assertJsonPath('error.code', 'validation_failed');

        $first = $this->admin('POST', "tenants/{$tenant->id}/billing/change-plan", $body, ['Idempotency-Key' => 'key-0000001'])->assertOk()
            ->assertJsonPath('data.plan.code', 'growth')->assertJsonPath('data.status', 'active');
        $sub = $this->subscriptionOf($tenant);
        $this->assertSame(['growth', Subscription::ACTIVE], [$sub->plan->code, $sub->status]);
        $this->assertSame([BillingInvoice::VOID, BillingInvoice::VOID_SUPERSEDED], [$this->invoiceOf($tenant, $open)->status, $this->invoiceOf($tenant, $open)->void_reason]);
        $this->assertStaffAudit($tenant->id, 'subscription.plan_changed', 'Partner deal');
        $this->assertSame('comp', $this->auditRow($tenant->id, 'subscription.plan_changed')->meta['kind']);
        Mail::assertQueued(AdminNoticeMail::class, fn (AdminNoticeMail $m) => $m->kind === AdminNoticeMail::PLAN_CHANGED);

        // replay → same answer, nothing changes; same key + another body → 409
        $this->admin('POST', "tenants/{$tenant->id}/billing/change-plan", $body, ['Idempotency-Key' => 'key-0000001'])->assertOk()
            ->assertHeader('Idempotent-Replayed', 'true')->assertJsonPath('data.id', $first->json('data.id'));
        $this->admin('POST', "tenants/{$tenant->id}/billing/change-plan", ['plan_code' => 'starter'] + $body, ['Idempotency-Key' => 'key-0000001'])
            ->assertStatus(409)->assertJsonPath('error.code', 'idempotency_key_mismatch');
        // same plan again with a fresh key → plan_unchanged
        $this->admin('POST', "tenants/{$tenant->id}/billing/change-plan", $body, ['Idempotency-Key' => 'key-0000002'])
            ->assertStatus(409)->assertJsonPath('error.code', 'plan_unchanged');
        $this->admin('POST', "tenants/{$tenant->id}/billing/change-plan", ['plan_code' => 'nope'] + $body, ['Idempotency-Key' => 'key-0000003'])
            ->assertStatus(422)->assertJsonPath('error.code', 'plan_unavailable');
    }

    public function test_change_plan_next_renewal_schedules_like_a_merchant_downgrade_and_quote_has_no_side_effects(): void
    {
        [, $tenant] = $this->shop();
        $this->onPaidPlan($tenant, 'growth');

        $this->admin('POST', "tenants/{$tenant->id}/billing/quote", ['plan_code' => 'starter', 'interval' => 'month', 'effective' => 'next_renewal'])
            ->assertOk()->assertJsonPath('data.kind', 'downgrade');
        $this->assertNull($this->subscriptionOf($tenant)->scheduled_plan_id);

        $this->admin('POST', "tenants/{$tenant->id}/billing/change-plan",
            ['plan_code' => 'starter', 'interval' => 'month', 'effective' => 'next_renewal', 'reason' => 'Asked by owner', 'notify' => false],
            ['Idempotency-Key' => (string) Str::ulid()])
            ->assertOk()->assertJsonPath('data.plan.code', 'growth')->assertJsonPath('data.scheduled_change.plan.code', 'starter');
        $this->assertStaffAudit($tenant->id, 'subscription.change_scheduled', 'Asked by owner');
        Mail::assertNotQueued(AdminNoticeMail::class);
    }

    public function test_extend_matches_the_command(): void
    {
        [, $tenant] = $this->shop();
        $before = $this->subscriptionOf($tenant)->trial_ends_at;

        $this->admin('POST', "tenants/{$tenant->id}/subscription/extend", ['days' => 91, 'reason' => 'Support case'])->assertStatus(422);
        $this->admin('POST', "tenants/{$tenant->id}/subscription/extend", ['days' => 7])->assertStatus(422);
        $this->admin('POST', "tenants/{$tenant->id}/subscription/extend", ['days' => 7, 'reason' => 'Support case'])->assertOk()
            ->assertJsonPath('data.status', 'trialing');
        $this->assertTrue($this->subscriptionOf($tenant)->trial_ends_at->equalTo($before->copy()->addDays(7)));
        $this->assertStaffAudit($tenant->id, 'billing.period_extended', 'Support case');
    }

    public function test_mark_paid_void_and_resend(): void
    {
        [, $tenant, , $h] = $this->shop();
        $invoice = $this->changePlan($h, 'starter')->json('data.invoice.id');
        $body = ['reference' => 'BANK-77', 'reason' => 'Bank transfer received'];

        $this->admin('POST', "invoices/{$invoice}/mark-paid", $body)->assertStatus(400);
        $this->admin('POST', "invoices/{$invoice}/mark-paid", ['reason' => 'Bank transfer received'], ['Idempotency-Key' => 'mark-000001'])->assertStatus(422);
        $this->admin('POST', "invoices/{$invoice}/mark-paid", $body, ['Idempotency-Key' => 'mark-000001'])->assertOk()
            ->assertJsonPath('data.status', 'paid')->assertJsonPath('data.payments.0.provider', 'manual')
            ->assertJsonPath('data.payments.0.provider_reference', fn ($v) => is_string($v))->assertJsonPath('data.tenant.id', $tenant->id);
        $this->assertSame('starter', $this->subscriptionOf($tenant)->plan->code);
        $this->assertStaffAudit($tenant->id, 'billing.manual_payment', 'Bank transfer received');
        $this->admin('POST', "invoices/{$invoice}/mark-paid", $body, ['Idempotency-Key' => 'mark-000001'])->assertOk()->assertJsonPath('data.status', 'paid');
        $this->admin('POST', "invoices/{$invoice}/mark-paid", $body, ['Idempotency-Key' => 'mark-000002'])->assertStatus(409)->assertJsonPath('error.code', 'invoice_not_open');

        $open = $this->changePlan($h, 'growth')->assertCreated()->json('data.invoice.id');
        $this->admin('POST', "invoices/{$open}/void", [])->assertStatus(422);
        $this->admin('POST', "invoices/{$open}/void", ['reason' => 'Issued in error'])->assertOk()->assertJsonPath('data.status', 'void')
            ->assertJsonPath('data.void_reason', 'manual');
        $this->assertStaffAudit($tenant->id, 'billing.invoice_voided', 'Issued in error');
        $this->admin('POST', "invoices/{$open}/void", ['reason' => 'Issued in error'])->assertStatus(409)->assertJsonPath('error.code', 'invoice_not_open');

        for ($i = 0; $i < 3; $i++) {
            $this->admin('POST', "invoices/{$invoice}/resend")->assertStatus(202);
        }
        $this->admin('POST', "invoices/{$invoice}/resend")->assertStatus(429)->assertJsonPath('error.code', 'rate_limited');
        Mail::assertQueued(BillingMail::class, fn (BillingMail $m) => $m->kind === BillingMail::PAYMENT_RECEIVED);
        $this->admin('POST', "invoices/{$open}/resend")->assertStatus(409);

        $unknown = strtolower((string) Str::ulid());
        $this->admin('POST', "invoices/{$unknown}/void", ['reason' => 'Issued in error'])->assertNotFound();
    }

    #[Group('security')]
    public function test_permissions_follow_the_matrix(): void
    {
        [, $tenant, , $h] = $this->shop();
        $invoice = $this->changePlan($h, 'starter')->json('data.invoice.id');
        foreach ([PlatformRole::Support, PlatformRole::ReadOnly] as $role) {
            $as = $this->staffUser($role);
            $this->admin('POST', "invoices/{$invoice}/void", ['reason' => 'Issued in error'], as: $as)->assertForbidden();
            $this->admin('POST', "tenants/{$tenant->id}/subscription/extend", ['days' => 3, 'reason' => 'Support case'], as: $as)->assertForbidden();
            $this->admin('GET', "invoices/{$invoice}", as: $as)->assertOk();
        }
        $this->assertSame('open', $this->invoiceOf($tenant, $invoice)->status);
    }

    /** S78: the Action runs as the tenant; given another tenant's id it can't see (RLS) or write the invoice. */
    #[Group('security')]
    #[Group('rls')]
    public function test_an_action_with_a_mismatched_tenant_fails(): void
    {
        [, $a, , $ha] = $this->shop(slug: 'mis-a');
        [, $b] = $this->shop(slug: 'mis-b');
        $invoice = $this->changePlan($ha, 'starter')->json('data.invoice.id');

        try {
            app(MarkInvoicePaid::class)->handle($b->id, $invoice, 'X', OpsActor::staff($this->staff, 'Wrong tenant'));
            $this->fail('the mismatched tenant must not reach the invoice');
        } catch (ModelNotFoundException|QueryException) {
            // RLS hides the row (or the tenant scope does without RLS)
        }
        $this->assertSame('open', $this->invoiceOf($a, $invoice)->status);
    }
}
