<?php

declare(strict_types=1);

namespace Tests\Feature\Billing;

use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Billing\Models\BillingPayment;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\BillingFixtures;
use Tests\Support\RlsFixtures;
use Tests\TestCase;

/** S56 under forced RLS: billing_invoices / billing_payments and the B22/B23 definer function. Postgres + RLS only. */
#[Group('rls')]
#[Group('tenancy')]
#[Group('billing')]
class BillingRlsTest extends TestCase
{
    use BillingFixtures, RefreshDatabase, RlsFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->requireRls();
        Mail::fake();
    }

    public function test_billing_rows_are_invisible_across_tenants_and_the_owner_lookup_returns_ids_only(): void
    {
        [, $a, , $ha] = $this->shop();
        [, $b, , $hb] = $this->shop('owner', 'bshop');
        $invoiceA = $this->changePlan($ha, 'starter')->assertCreated()->json('data.invoice.id');
        $invoiceB = $this->changePlan($hb, 'growth')->assertCreated()->json('data.invoice.id');
        $paymentB = $this->payInvoice($hb, $invoiceB)->assertCreated()->json('data.id');

        $this->setGuc($a->id);
        $this->assertSame([$invoiceA], DB::table('billing_invoices')->pluck('id')->all());
        $this->assertSame(0, DB::table('billing_payments')->count());
        $this->assertSame(0, DB::table('billing_invoices')->where('id', $invoiceB)->update(['status' => 'paid']));
        $this->assertSame('42501', $this->sqlState(fn () => DB::table('billing_payments')->insert([
            'id' => strtolower((string) Str::ulid()), 'tenant_id' => $b->id, 'invoice_id' => $invoiceB, 'provider' => 'bkash',
            'status' => 'succeeded', 'amount' => 1, 'currency' => 'BDT', 'expires_at' => now(),
        ])));

        $this->setGuc(null);
        $this->assertSame(0, DB::table('billing_invoices')->count(), 'no tenant: nothing');
        $this->assertSame($b->id, trim((string) DB::selectOne('select tenant_id from sp_billing_payment_owner(?)', [$paymentB])->tenant_id));
        $this->assertSame([], DB::select('select * from sp_billing_payment_owner(?)', [strtolower((string) Str::ulid())]));
        $f = DB::selectOne("select p.prosecdef, array_to_string(p.proconfig, ',') as config, has_function_privilege('public', p.oid, 'execute') as public_execute
            from pg_proc p where p.proname = 'sp_billing_payment_owner'");
        $this->assertTrue((bool) $f->prosecdef);
        $this->assertStringContainsString('search_path=public, pg_temp', (string) $f->config);
        $this->assertFalse((bool) $f->public_execute);

        $this->assertSame('pending', $this->inTenant($b, fn () => BillingPayment::query()->findOrFail($paymentB)->status));
        $this->assertSame('open', $this->inTenant($b, fn () => BillingInvoice::query()->findOrFail($invoiceB)->status));
    }
}
