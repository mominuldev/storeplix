<?php

namespace Tests\Feature\Tenancy\Rls;

use App\Domain\Tenancy\Database\RlsTables;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\RlsFixtures;
use Tests\TestCase;

/**
 * S19 (PHASE-5B-CONTRACT §2.6, §12): raw SQL on the app connection (storeplix_app, no app-level scope) can't read,
 * insert, update or delete another tenant's rows. Postgres + TENANCY_RLS=true only (CI api-rls).
 */
#[Group('rls')]
#[Group('tenancy')]
class RlsRawSqlTest extends TestCase
{
    use RefreshDatabase, RlsFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->requireRls();
    }

    public function test_guc_of_tenant_a_sees_only_a_rows(): void
    {
        $t = $this->twoTenantsWithOrders();
        $this->assertSame(2, $this->platformTable('orders')->count(), 'fixture: one order per tenant');

        $this->setGuc($t['a']['tenant']->id);
        $this->assertSame(1, (int) DB::selectOne('select count(*) as c from orders')->c);
        $this->assertSame([$t['a']['tenant']->id], DB::table('orders')->pluck('tenant_id')->map(fn ($v) => trim((string) $v))->all());
        $this->assertSame(0, DB::table('orders')->where('id', $t['b']['order'])->count());
        $this->assertSame(0, DB::table('stores')->where('id', $t['b']['store']->id)->count());

        // The GUC follows the TenantContext (set / run / restore).
        $this->setGuc(null);
        $seen = $this->inTenant($t['b']['tenant'], fn () => DB::table('orders')->pluck('id')->map(fn ($v) => trim((string) $v))->all());
        $this->assertSame([$t['b']['order']], $seen);
        $this->assertSame('', $this->guc());
    }

    public function test_unset_guc_sees_nothing_in_any_tenant_table(): void
    {
        $this->twoTenantsWithOrders();
        foreach (['orders', 'stores', 'tenant_users', 'audit_logs', 'products', 'customers'] as $table) {
            $this->assertGreaterThan(0, $this->platformTable($table)->count(), "fixture: {$table} has rows");
        }

        $this->setGuc(null, null);
        foreach (RlsTables::TENANT as $table) {
            if (in_array($table, RlsTables::APP_REVOKED, true)) { // PHASE-8-2 S84: no privilege at all
                $this->assertSame('42501', $this->sqlState(fn () => DB::selectOne("select count(*) as c from \"{$table}\"")), $table);

                continue;
            }
            // sms_messages: account-level OTP rows (tenant_id null) stay readable without a tenant (RlsPolicies).
            $sql = $table === 'sms_messages'
                ? 'select count(*) as c from "sms_messages" where tenant_id is not null'
                : "select count(*) as c from \"{$table}\"";
            $this->assertSame(0, (int) DB::selectOne($sql)->c, "{$table} leaks rows without app.tenant_id");
        }
    }

    public function test_insert_for_another_tenant_is_rejected(): void
    {
        $t = $this->twoTenantsWithOrders();
        $row = (array) $this->platformTable('orders')->where('id', $t['b']['order'])->first();
        $row['id'] = strtolower((string) Str::ulid());
        $row['number'] = 'RLS-'.random_int(1000, 9999);

        $this->setGuc($t['a']['tenant']->id);
        $this->assertSame('42501', $this->sqlState(fn () => DB::table('orders')->insert($row)));

        // tenant_users (special policy): a membership row for B under A is rejected too.
        $this->assertSame('42501', $this->sqlState(fn () => DB::table('tenant_users')->insert([
            'id' => strtolower((string) Str::ulid()), 'tenant_id' => $t['b']['tenant']->id, 'user_id' => $t['a']['user']->id,
            'role' => 'staff', 'created_at' => now(), 'updated_at' => now(),
        ])));

        // GUC unset: no tenant row can be inserted at all (fail closed).
        $this->setGuc(null);
        $row['id'] = strtolower((string) Str::ulid());
        $this->assertSame('42501', $this->sqlState(fn () => DB::table('orders')->insert($row)));
        $this->assertSame(2, $this->platformTable('orders')->count());
    }

    public function test_update_and_delete_of_another_tenants_rows_touch_nothing(): void
    {
        $t = $this->twoTenantsWithOrders();
        $before = $this->platformTable('orders')->where('id', $t['b']['order'])->value('updated_at');

        $this->setGuc($t['a']['tenant']->id);
        $this->assertSame(0, DB::update("update orders set customer_note = 'rls probe', updated_at = now() where id = ?", [$t['b']['order']]));
        $this->assertSame(0, DB::delete('delete from orders where id = ?', [$t['b']['order']]));
        $this->assertSame(0, DB::delete('delete from orders where tenant_id = ?', [$t['b']['tenant']->id]));
        // moving one of A's rows into B is refused by WITH CHECK
        $this->assertSame('42501', $this->sqlState(fn () => DB::update('update orders set tenant_id = ? where id = ?', [$t['b']['tenant']->id, $t['a']['order']])));

        $this->assertSame(1, $this->platformTable('orders')->where('id', $t['b']['order'])->count());
        $this->assertSame($before, $this->platformTable('orders')->where('id', $t['b']['order'])->value('updated_at'));
        $this->assertSame(1, $this->platformTable('orders')->where('id', $t['a']['order'])->where('tenant_id', $t['a']['tenant']->id)->count());
    }

    public function test_audit_logs_are_append_only_for_the_app_role(): void
    {
        $t = $this->twoTenantsWithOrders();
        $this->setGuc($t['a']['tenant']->id);

        $this->assertSame('42501', $this->sqlState(fn () => DB::update("update audit_logs set action = 'tampered'")));
        $this->assertSame('42501', $this->sqlState(fn () => DB::delete('delete from audit_logs')));
        // platform (tenant_id null) events stay insertable, but are not readable by the app role
        DB::table('audit_logs')->insert(['id' => $id = strtolower((string) Str::ulid()), 'tenant_id' => null, 'actor_type' => 'system', 'action' => 'rls.probe', 'created_at' => now()]);
        $this->assertSame(0, DB::table('audit_logs')->where('id', $id)->count());
        $this->assertSame(1, $this->platformTable('audit_logs')->where('id', $id)->count());
    }

    public function test_memberships_are_visible_by_user_before_a_tenant_is_set(): void
    {
        $t = $this->twoTenantsWithOrders();

        $this->setGuc(null, $t['a']['user']->id);
        $this->assertSame([$t['a']['tenant']->id], DB::table('tenant_users')->pluck('tenant_id')->map(fn ($v) => trim((string) $v))->all());

        $this->setGuc(null, null);
        $this->assertSame(0, DB::table('tenant_users')->count());
    }

    /** QA 5b-1 F-L2: memberships of other tenants are readable by user, but never writable from another tenant. */
    public function test_a_user_cannot_change_their_memberships_in_other_tenants(): void
    {
        $t = $this->twoTenantsWithOrders();
        $userA = $t['a']['user']->id;
        $membership = [
            'id' => strtolower((string) Str::ulid()), 'tenant_id' => $t['b']['tenant']->id, 'user_id' => $userA,
            'role' => 'staff', 'created_at' => now(), 'updated_at' => now(),
        ];
        $this->platformTable('tenant_users')->insert($membership); // A's user is also staff in B

        $this->setGuc($t['a']['tenant']->id, $userA);
        $this->assertSame(2, DB::table('tenant_users')->where('user_id', $userA)->count(), 'own memberships stay readable');
        $this->assertSame(0, DB::update("update tenant_users set role = 'admin' where id = ?", [$membership['id']]));
        $this->assertSame(0, DB::delete('delete from tenant_users where id = ?', [$membership['id']]));
        $this->assertSame('staff', $this->platformTable('tenant_users')->where('id', $membership['id'])->value('role'));
    }
}
