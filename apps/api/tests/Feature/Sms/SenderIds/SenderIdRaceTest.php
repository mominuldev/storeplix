<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\SenderIds;

use App\Domain\Sms\Models\SmsSenderId;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Mail;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\ForksRaces;
use Tests\TestCase;

/** PHASE-8-9A S215 (Postgres race): two shops asking for the same sender ID at once → one 201, the other 409 sender_id_taken. */
#[Group('sms')]
#[Group('race')]
class SenderIdRaceTest extends TestCase
{
    use ForksRaces, RefreshDatabase, SenderIdFixtures;

    public function test_two_shops_racing_for_one_sender_id_get_one_request(): void
    {
        $this->requirePostgresRace();
        try {
            $this->setUpSenderIds();
            Mail::fake();
            [, , $storeA, $hA] = $this->shop(slug: 'racea');
            [, , $storeB, $hB] = $this->shop(slug: 'raceb');

            $results = $this->parallel(4, fn (int $i) => $i % 2 === 0
                ? $this->requestId($hA, $storeA, ['sender_id' => 'RaceID'])->status()
                : $this->requestId($hB, $storeB, ['sender_id' => 'raceid'])->status());
            sort($results);
            $this->assertSame([201, 409, 409, 409], $results, json_encode($results));
            $this->assertSame(1, SmsSenderId::withoutTenancy()->whereRaw('lower(sender_id) = ?', ['raceid'])->where('status', 'pending')->count());
        } finally {
            $this->raceCleanup();
        }
    }
}
