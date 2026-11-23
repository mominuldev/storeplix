<?php

declare(strict_types=1);

namespace Tests\Feature\Billing;

use PHPUnit\Framework\Attributes\Group;
use Symfony\Component\Finder\Finder;
use Tests\TestCase;

/** PHASE-7 §2.2, S58, B26: source-level rules (runs everywhere; reads files, not the database). */
#[Group('billing')]
#[Group('security')]
class BillingArchTest extends TestCase
{
    public function test_plan_limits_are_read_only_inside_billing(): void
    {
        $this->assertSame([], $this->offenders('/->limits\b|[\'"]limits[\'"]\s*\]|plans\.limits/', '#^app/Domain/Billing/#'));
    }

    public function test_billing_never_loads_merchant_gateway_accounts_and_merchant_code_never_reads_platform_credentials(): void
    {
        $this->assertSame([], $this->inside('/PaymentGatewayAccount::(query|where|find)|payment_gateway_accounts/', '#^app/Domain/Billing/#'),
            'billing code must not read merchant accounts');
        $this->assertSame([], $this->offenders('/config\(\s*[\'"]billing\.(bkash|sslcommerz)/', '#^app/Domain/Billing/#'), 'merchant code must not read platform credentials');
    }

    public function test_only_the_allocator_writes_platform_counters(): void
    {
        $this->assertSame([], $this->offenders('/platform_counters/', '#^(app/Domain/Billing/Support/InvoiceNumberAllocator\.php|database/migrations/|app/Domain/Tenancy/Database/RlsTables\.php)#'));
    }

    /** Files under $scope matching $pattern. @return list<string> */
    private function inside(string $pattern, string $scope): array
    {
        $found = [];
        foreach ((new Finder)->files()->name('*.php')->in([base_path('app')]) as $file) {
            $path = str_replace(base_path().'/', '', $file->getRealPath());
            if (preg_match($scope, $path) === 1 && preg_match($pattern, $file->getContents()) === 1) {
                $found[] = $path;
            }
        }

        return $found;
    }

    /** Files matching $pattern whose path does NOT match $allowed. @return list<string> */
    private function offenders(string $pattern, string $allowed): array
    {
        $found = [];
        foreach ((new Finder)->files()->name('*.php')->in([base_path('app'), base_path('database'), base_path('routes')]) as $file) {
            $path = str_replace(base_path().'/', '', $file->getRealPath());
            if (preg_match($pattern, $file->getContents()) === 1 && preg_match($allowed, $path) !== 1) {
                $found[] = $path;
            }
        }
        sort($found);

        return $found;
    }
}
