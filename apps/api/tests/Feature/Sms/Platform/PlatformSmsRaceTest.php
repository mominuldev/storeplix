<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\Platform;

use App\Domain\Shared\Http\ApiException;
use App\Domain\Sms\Broadcasts\BroadcastService;
use App\Domain\Sms\Broadcasts\Jobs\StartPlatformBroadcast;
use App\Domain\Sms\Models\PlatformSmsBroadcast;
use App\Domain\Sms\Models\SmsProvider;
use App\Domain\Sms\Providers\SmsProviderService;
use App\Domain\Tenancy\Support\PlatformDb;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Bus;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\ForksRaces;
use Tests\TestCase;

/**
 * PHASE-8-9B races on Postgres (CI race job): two activations of different providers as primary → exactly one primary
 * (row locks + partial unique index); one broadcast scheduled twice → one schedule; two broadcasts materialising for the
 * same tenant at once → the weekly cap holds under the tenant-keyed advisory lock (S228).
 */
#[Group('platform-sms')]
#[Group('race')]
class PlatformSmsRaceTest extends TestCase
{
    use ForksRaces, PlatformSmsFixtures, RefreshDatabase;

    public function test_two_activations_leave_one_primary(): void
    {
        $this->requirePostgresRace();
        try {
            $this->setUpPlatformSms();
            $this->reveOk();
            $ids = [$this->createProvider($this->reveInput(['name' => 'One'])), $this->createProvider($this->reveInput(['name' => 'Two']))];
            foreach ($ids as $id) {
                $this->admin('POST', "providers/{$id}/test", ['phone' => '01711552211'])->assertOk();
            }
            $staff = $this->super();
            $results = $this->parallel(2, function (int $i) use ($ids, $staff) {
                $p = SmsProviderService::locate($ids[$i]);
                app(SmsProviderService::class)->activate($p, SmsProvider::PRIMARY, $p->name, false, $staff);

                return 200;
            });
            $this->assertContains(200, $results);
            $this->assertSame(1, $this->platformTable('sms_providers')->where('role', 'primary')->count());
        } finally {
            $this->raceCleanup();
        }
    }

    public function test_a_broadcast_scheduled_twice_is_scheduled_once_and_the_cap_holds(): void
    {
        $this->requirePostgresRace();
        try {
            $this->setUpPlatformSms();
            $this->travelTo(Carbon::parse('2026-12-01 10:00', 'Asia/Dhaka'));
            $this->reveOk();
            $this->activeProvider($this->reveInput());
            [, $tenant] = $this->owner('alpha');
            Bus::fake([StartPlatformBroadcast::class]);
            $body = ['name' => 'Offer', 'body_bn' => 'অফার {link}', 'body_en' => 'Offer {link}', 'audience' => ['kind' => 'all'], 'scheduled_at' => null];
            $id = $this->admin('POST', 'broadcasts', $body)->assertCreated()->json('data.id');
            $staff = $this->super();
            $results = $this->parallel(2, function () use ($id, $staff) {
                try {
                    app(BroadcastService::class)->schedule(BroadcastService::locate($id), 1, 1, $staff);

                    return 200;
                } catch (ApiException $e) {
                    return $e->getStatusCode();
                }
            });
            sort($results);
            $this->assertSame([200, 409], $results);

            // Three sending broadcasts materialise at once for one tenant: at most 2 pending/sent rows (weekly cap).
            $ids = [];
            foreach ([1, 2, 3] as $n) {
                $b = new PlatformSmsBroadcast;
                $b->forceFill(['name' => "B{$n}", 'body_bn' => 'x {link}', 'body_en' => 'y {link}', 'audience' => ['kind' => 'all'], 'status' => 'sending', 'started_at' => now()]);
                $b->setConnection(PlatformDb::connectionName());
                $b->save();
                $ids[] = $b->id;
            }
            $this->parallel(3, function (int $i) use ($ids) {
                (new StartPlatformBroadcast($ids[$i]))->handle();

                return 200;
            });
            $this->assertLessThanOrEqual(2, $this->platformTable('platform_sms_broadcast_recipients')->where('tenant_id', $tenant->id)
                ->whereIn('status', ['pending', 'sent'])->count());
        } finally {
            $this->raceCleanup();
        }
    }
}
