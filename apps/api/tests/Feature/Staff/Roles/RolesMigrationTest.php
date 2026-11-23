<?php

declare(strict_types=1);

namespace Tests\Feature\Staff\Roles;

use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-3 §10 migration test: pre-8.3 tenants (O/A/S members; open, accepted and revoked invitations, no roles) get
 * their system roles and matching role_id from 000300; re-running it is a no-op. sqlite only: on Postgres 000400's
 * NOT NULL + FK make a pre-8.3 row unrepresentable (the CI api-postgres job runs the backfill on an empty schema).
 */
#[Group('roles')]
class RolesMigrationTest extends TestCase
{
    use RefreshDatabase;

    public function test_backfill_sets_system_role_ids_everywhere_and_is_idempotent(): void
    {
        if (DB::getDriverName() !== 'sqlite') {
            $this->markTestSkipped('pre-8.3 rows are unrepresentable under the Postgres constraints');
        }
        $now = now();
        $tenants = [];
        foreach (['a', 'b'] as $t) {
            $tenant = (string) Str::ulid();
            DB::table('tenants')->insert(['id' => $tenant, 'name' => "Legacy {$t}", 'status' => 'active', 'created_at' => $now, 'updated_at' => $now]);
            foreach (['owner', 'admin', 'staff'] as $role) {
                $user = (string) Str::ulid();
                DB::table('users')->insert(['id' => $user, 'name' => $role, 'email' => "{$t}-{$role}@example.test", 'password' => 'x', 'created_at' => $now, 'updated_at' => $now]);
                DB::table('tenant_users')->insert(['id' => (string) Str::ulid(), 'tenant_id' => $tenant, 'user_id' => $user, 'role' => $role, 'created_at' => $now, 'updated_at' => $now]);
            }
            $inviter = DB::table('tenant_users')->where('tenant_id', $tenant)->where('role', 'owner')->value('user_id');
            foreach ([['admin', null, null], ['staff', $now, null], ['staff', null, $now]] as $i => [$role, $accepted, $revoked]) {
                DB::table('staff_invitations')->insert([
                    'id' => (string) Str::ulid(), 'tenant_id' => $tenant, 'email' => "{$t}-inv{$i}@example.test", 'role' => $role,
                    'token_hash' => Str::random(64), 'invited_by' => $inviter, 'expires_at' => $now->copy()->addDay(),
                    'accepted_at' => $accepted, 'revoked_at' => $revoked, 'last_sent_at' => $now, 'created_at' => $now, 'updated_at' => $now,
                ]);
            }
            $tenants[] = $tenant;
        }

        $migration = require database_path('migrations/2026_11_01_000300_backfill_system_roles.php');
        $migration->up();

        foreach ($tenants as $tenant) {
            $roles = DB::table('roles')->where('tenant_id', $tenant)->pluck('id', 'key')->all();
            $this->assertSame(['admin', 'owner', 'staff'], collect(array_keys($roles))->sort()->values()->all());
            foreach (['tenant_users', 'staff_invitations'] as $table) {
                foreach (DB::table($table)->where('tenant_id', $tenant)->get() as $row) {
                    $this->assertSame($roles[$row->role], $row->role_id, "{$table} {$row->id}");
                }
            }
        }
        $this->assertSame(0, DB::table('tenant_users')->whereNull('role_id')->count());
        $this->assertSame(0, DB::table('staff_invitations')->whereNull('role_id')->count());

        $before = [DB::table('roles')->orderBy('id')->get()->toArray(), DB::table('tenant_users')->orderBy('id')->pluck('role_id')->all()];
        $migration->up();
        $this->assertEquals($before, [DB::table('roles')->orderBy('id')->get()->toArray(), DB::table('tenant_users')->orderBy('id')->pluck('role_id')->all()]);
    }
}
