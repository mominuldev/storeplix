<?php

/*
| Postgres row-level security (PHASE-5B-CONTRACT §2.2, ADR 0012).
|
| TENANCY_RLS=true turns on GUC syncing (app.tenant_id / app.user_id follow the TenantContext and the signed-in
| user), the definer-function lookups for pre-tenant paths, and the withoutTenancy() reroute to the admin
| connection. It only has an effect when the default connection is Postgres: sqlite ignores it.
|
| With TENANCY_RLS=true the app must NOT connect as the schema owner or a superuser (boot check).
*/

return [

    'rls' => (bool) env('TENANCY_RLS', false),

    // Schema owner (migrations, seeders): `php artisan migrate --database=pgsql_owner`.
    'owner_connection' => 'pgsql_owner',

    // BYPASSRLS platform role: withoutTenancy(), console commands, scheduler, platform jobs, future /admin/*.
    'admin_connection' => 'pgsql_admin',

];
