<?php

declare(strict_types=1);

namespace Tests\Feature\Inbox;

use App\Domain\Inbox\Models\InboxConversation;
use App\Domain\Inbox\WidgetService;
use Illuminate\Database\QueryException;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Str;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * S234 at the database (PHASE-8-8E §3): the 8 Inbox tables are under forced RLS; the storefront, merchant, inbound
 * email (sp_inbox_route) and prune paths all work with RLS on. TENANCY_RLS=true on Postgres only (CI api-rls).
 */
#[Group('inbox')]
#[Group('rls')]
#[Group('security')]
#[Group('tenancy')]
class InboxRlsTest extends TestCase
{
    use InboxFixtures, RefreshDatabase;

    private const TABLES = ['inbox_settings', 'inbox_conversations', 'inbox_messages', 'inbox_attachments', 'inbox_reads',
        'inbox_saved_replies', 'inbox_widget_sessions', 'inbox_magic_links'];

    public function test_inbox_tables_are_isolated_and_every_path_works_under_rls(): void
    {
        if (! $this->rlsActive()) {
            $this->markTestSkipped('Needs TENANCY_RLS=true on Postgres as storeplix_app (CI api-rls).');
        }
        $this->setUpInbox();
        Mail::fake();
        $shops = [];
        foreach (['alpha', 'beta'] as $slug) {
            [, $tenant, $store, $h] = $this->inboxShop($slug);
            [, $id] = $this->verifiedChat($tenant, $store);
            $msg = $this->reply($h, $store, $id, 'Hi', ['attachment_ids' => [$this->inboxUpload($h, $store, 'a.pdf', self::pdf())->json('data.id')]])->assertCreated()->json('data.id');
            $this->api($h, 'POST', $this->iUrl($store, "/conversations/{$id}/read"), ['last_read_message_id' => $msg])->assertNoContent();
            $this->api($h, 'POST', $this->iUrl($store, '/saved-replies'), ['title' => 'T', 'shortcut' => 'tt', 'body' => 'Hi'])->assertCreated();
            $this->inTenant($tenant, fn () => app(WidgetService::class)->magicLink(InboxConversation::query()->findOrFail($id)));
            $this->inbound(['recipient' => 'shop-'.$this->storeAddress($tenant, $store).'@in.storeplix.test'])->assertStatus(202)->assertJsonPath('data.accepted', true);
            $shops[$slug] = [$tenant, $store];
        }
        $this->artisan('inbox:prune')->assertSuccessful();
        [$tenantA] = $shops['alpha'];
        [$tenantB, $storeB] = $shops['beta'];
        $this->assertSame(1, (int) $this->platformTable('inbox_conversations')->where('tenant_id', $tenantB->id)->where('channel', 'email')->count());

        $this->setGuc($tenantA->id);
        foreach (self::TABLES as $table) {
            $tenants = array_map(fn ($r) => trim((string) $r->tenant_id), DB::select("select tenant_id from {$table}"));
            $this->assertNotEmpty($tenants, $table);
            $this->assertSame([$tenantA->id], array_values(array_unique($tenants)), $table);
        }
        $refused = null;
        try {
            DB::insert("insert into inbox_saved_replies (id, tenant_id, store_id, title, shortcut, body, created_at, updated_at) values (?, ?, ?, 'x', 'xx', 'x', now(), now())",
                [strtolower((string) Str::ulid()), $tenantB->id, $storeB->id]);
        } catch (QueryException $e) {
            $refused = $e;
        }
        $this->assertNotNull($refused);

        $this->setGuc(null);
        foreach (self::TABLES as $table) {
            $this->assertSame(0, (int) DB::selectOne("select count(*) as c from {$table}")->c, $table);
        }
    }

    private function setGuc(?string $tenantId): void
    {
        DB::statement("select set_config('app.tenant_id', ?, false), set_config('app.user_id', '', false)", [(string) $tenantId]);
    }
}
