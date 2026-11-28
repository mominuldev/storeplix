<?php

declare(strict_types=1);

namespace App\Domain\Sms\Broadcasts;

use App\Domain\Identity\Models\User;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Sms\Broadcasts\Jobs\StartPlatformBroadcast;
use App\Domain\Sms\Models\PlatformSmsBroadcast;
use App\Domain\Sms\Models\PlatformSmsBroadcastRecipient;
use App\Domain\Sms\Models\SmsProvider;
use App\Domain\Sms\Platform\PlatformSmsMessageTypes;
use App\Domain\Sms\Platform\PlatformSmsTemplates;
use App\Domain\Sms\Platform\PlatformSmsType;
use App\Domain\Sms\Providers\SmsProviderService;
use App\Domain\Sms\Routing\ProviderRoute;
use App\Domain\Sms\Routing\SmsRoutingTable;
use App\Domain\Sms\SmsRoute;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\Support\PlatformDb;
use Illuminate\Database\Eloquent\Builder;
use Illuminate\Support\Carbon;

/**
 * PHASE-8-9B §7 (P89B-17 – P89B-22, S228): draft CRUD, estimate, schedule (typed recipient count against a FRESH
 * estimate; the broadcast row is locked) and cancel. Platform-only tables: always the platform connection.
 */
final class BroadcastService
{
    public function __construct(
        private readonly AuditLogger $audit,
        private readonly SmsRoutingTable $table,
        private readonly PlatformSmsMessageTypes $types,
    ) {}

    /** @return Builder<PlatformSmsBroadcast> */
    public static function query(): Builder
    {
        return PlatformDb::reroute(PlatformSmsBroadcast::query());
    }

    /** @return Builder<PlatformSmsBroadcastRecipient> */
    public static function recipients(string $broadcastId): Builder
    {
        return PlatformDb::reroute(PlatformSmsBroadcastRecipient::query())->where('broadcast_id', $broadcastId);
    }

    public static function locate(string $id): PlatformSmsBroadcast
    {
        $row = preg_match('/^[0-9A-Za-z]{26}$/', $id) === 1 ? self::query()->whereKey(strtolower($id))->first() : null;

        return $row ?? throw new ApiException(404, 'not_found', 'Resource not found.');
    }

    /** @param array<string, mixed> $input validated */
    public function create(array $input, User $by): PlatformSmsBroadcast
    {
        $scheduled = self::scheduledAt($input['scheduled_at'] ?? null);
        if ($scheduled !== null) {
            SendingHours::assertSchedulable($scheduled);
        }
        $broadcast = new PlatformSmsBroadcast;
        $broadcast->forceFill([
            'name' => trim((string) $input['name']),
            'body_bn' => BroadcastTexts::validate((string) $input['body_bn'], 'bn', 'body_bn'),
            'body_en' => BroadcastTexts::validate((string) $input['body_en'], 'en', 'body_en'),
            'audience' => BroadcastAudience::normalise((array) $input['audience']),
            'scheduled_at' => $scheduled, 'status' => PlatformSmsBroadcast::DRAFT, 'created_by' => $by->id,
        ]);
        $broadcast->setConnection(PlatformDb::connectionName());
        $broadcast->save();
        $this->audit->log('platform_sms_broadcast.created', $broadcast, ['name' => $broadcast->name, 'audience' => $broadcast->audience], $by, tenantId: false, platform: true);

        return $broadcast->refresh();
    }

    /** @param array<string, mixed> $input validated */
    public function update(PlatformSmsBroadcast $b, array $input, User $by): PlatformSmsBroadcast
    {
        if ($b->status !== PlatformSmsBroadcast::DRAFT) {
            throw self::wrongState();
        }
        if ((int) $input['revision'] !== $b->revision) {
            throw self::revisionConflict();
        }
        $changes = [];
        if (array_key_exists('name', $input)) {
            $changes['name'] = trim((string) $input['name']);
        }
        foreach (['bn', 'en'] as $language) {
            if (array_key_exists("body_{$language}", $input)) {
                $changes["body_{$language}"] = BroadcastTexts::validate((string) $input["body_{$language}"], $language, "body_{$language}");
            }
        }
        if (array_key_exists('audience', $input)) {
            $changes['audience'] = json_encode(BroadcastAudience::normalise((array) $input['audience']));
        }
        if (array_key_exists('scheduled_at', $input)) {
            $scheduled = self::scheduledAt($input['scheduled_at']);
            if ($scheduled !== null) {
                SendingHours::assertSchedulable($scheduled);
            }
            $changes['scheduled_at'] = $scheduled;
        }
        $moved = self::query()->whereKey($b->id)->where('status', PlatformSmsBroadcast::DRAFT)->where('revision', $b->revision)
            ->update($changes + ['revision' => $b->revision + 1, 'updated_at' => now()]);
        if ($moved !== 1) {
            throw self::revisionConflict();
        }
        $this->audit->log('platform_sms_broadcast.updated', $b, ['changed' => array_keys($changes)], $by, tenantId: false, platform: true);

        return self::locate($b->id);
    }

    public function delete(PlatformSmsBroadcast $b, User $by): void
    {
        if (self::query()->whereKey($b->id)->where('status', PlatformSmsBroadcast::DRAFT)->delete() !== 1) {
            throw self::wrongState();
        }
        $this->audit->log('platform_sms_broadcast.deleted', $b, ['name' => $b->name], $by, tenantId: false, platform: true);
    }

    /** The provider that would carry promotional SMS now (ignoring the breaker and the mask status). */
    public function carrier(): ?ProviderRoute
    {
        return $this->table->candidates(SmsRoute::Promotional->value)[0] ?? null;
    }

    /**
     * P89B-19 PlatformSmsBroadcastEstimate (no side effects).
     *
     * @param  array<string, mixed>  $audience
     * @return array<string, mixed>
     */
    public function estimate(array $audience, string $bodyBn, string $bodyEn, ?string $exceptBroadcast = null): array
    {
        $audience = BroadcastAudience::normalise($audience);
        $members = BroadcastAudience::members($audience);
        $cap = BroadcastAudience::capCounts($exceptBroadcast);
        $skipped = array_fill_keys(BroadcastAudience::SKIP_ORDER, 0);
        $seen = [];
        $byLanguage = ['bn' => 0, 'en' => 0];
        foreach ($members as $t) {
            $reason = BroadcastAudience::skipReason($t, $cap, $seen);
            $reason === null ? $byLanguage[$t['language']]++ : $skipped[$reason]++;
        }
        $partsBn = BroadcastTexts::sampleParts($bodyBn, 'bn');
        $partsEn = BroadcastTexts::sampleParts($bodyEn, 'en');
        $total = $byLanguage['bn'] * $partsBn + $byLanguage['en'] * $partsEn;
        $carrier = $this->carrier();
        $provider = $carrier?->id !== null ? SmsProvider::query()->find($carrier->id) : null;
        $price = $provider?->price_masking_paisa ?? ($carrier?->environment ? (int) config('sms.drivers.revesms.price_masking_paisa', 0) : 0);
        $cost = $total * (int) $price;
        $balance = $provider !== null && $provider->balance_status === 'ok' ? $provider->balance_amount : null;
        $after = $balance !== null ? $balance - $cost : null;

        return [
            'recipients' => $byLanguage['bn'] + $byLanguage['en'],
            'skipped' => $skipped,
            'parts_bn' => $partsBn,
            'parts_en' => $partsEn,
            'parts_per_sms' => max($partsBn, $partsEn),
            'total_parts' => $total,
            'cost_paisa' => $cost,
            'balance_paisa' => $balance,
            'balance_after_paisa' => $after,
            'below_alert' => $after !== null && $provider?->low_threshold_paisa !== null && $after < $provider->low_threshold_paisa,
            'sender_id' => $carrier?->promotionalSender,
            'sender_status' => $carrier?->promotionalStatus,
            'checks' => ['sending_hours' => SendingHours::open(), 'stop_footer' => true, 'opt_outs_honoured' => true,
                'weekly_cap' => (int) config('sms.platform.weekly_cap', 2)],
        ];
    }

    /** §7.4 schedule — checks in the contract's order; the broadcast row is locked (a second schedule gets 409). */
    public function schedule(PlatformSmsBroadcast $b, int $confirmRecipients, int $revision, User $by): PlatformSmsBroadcast
    {
        $result = PlatformDb::connection()->transaction(function () use ($b, $confirmRecipients, $revision, $by) {
            $row = self::query()->whereKey($b->id)->lockForUpdate()->first() ?? throw new ApiException(404, 'not_found', 'Resource not found.');
            if ($row->status !== PlatformSmsBroadcast::DRAFT) {
                throw self::wrongState();
            }
            if ($row->revision !== $revision) {
                throw self::revisionConflict();
            }
            if (! PlatformSmsTemplates::enabled(PlatformSmsType::Broadcast)) {
                throw new ApiException(409, 'platform_sms_type_disabled', 'Broadcasts are switched off on the Message types tab.');
            }
            SendingHours::assertSchedulable($row->scheduled_at);
            $carrier = $this->carrier();
            if ($carrier === null || $carrier->promotionalStatus !== 'approved' || ($carrier->promotionalSender ?? '') === '') {
                throw new ApiException(409, 'promotional_sender_not_approved', 'The promotional sender ID isn’t approved yet, so broadcasts can’t be scheduled.');
            }
            $estimate = $this->estimate((array) $row->audience, $row->body_bn, $row->body_en, $row->id);
            if ($estimate['recipients'] === 0) {
                throw new ApiException(422, 'broadcast_empty_audience', 'Nobody in this audience can receive the broadcast.');
            }
            if ($estimate['recipients'] !== $confirmRecipients) {
                throw new ApiException(409, 'broadcast_estimate_changed', 'The number of recipients changed. Check the new numbers and confirm again.', $estimate);
            }
            if ($estimate['balance_paisa'] !== null && $estimate['cost_paisa'] > $estimate['balance_paisa']) {
                throw new ApiException(422, 'gateway_balance_insufficient', 'The gateway balance is too low for this broadcast.',
                    ['cost_paisa' => $estimate['cost_paisa'], 'balance_paisa' => $estimate['balance_paisa']]);
            }
            $now = $row->scheduled_at === null;
            self::query()->whereKey($row->id)->update([
                'status' => $now ? PlatformSmsBroadcast::SENDING : PlatformSmsBroadcast::SCHEDULED,
                'estimate' => json_encode($estimate), 'confirmed_by' => $by->id, 'confirmed_at' => now(),
                'provider_id' => $carrier->id, 'sender_id' => $carrier->promotionalSender, 'started_at' => $now ? now() : null,
                'revision' => $row->revision + 1, 'updated_at' => now(),
            ]);

            return [$now, $estimate];
        });
        [$now, $estimate] = $result;
        $this->audit->log('platform_sms_broadcast.scheduled', $b, ['recipients' => $estimate['recipients'], 'total_parts' => $estimate['total_parts'],
            'cost_paisa' => $estimate['cost_paisa'], 'scheduled_at' => $b->scheduled_at?->toIso8601ZuluString()], $by, tenantId: false, platform: true);
        if ($now) {
            StartPlatformBroadcast::dispatch($b->id)->afterCommit();
        }

        return self::locate($b->id);
    }

    public function cancel(PlatformSmsBroadcast $b, User $by): PlatformSmsBroadcast
    {
        $moved = self::query()->whereKey($b->id)->where('status', PlatformSmsBroadcast::SCHEDULED)
            ->update(['status' => PlatformSmsBroadcast::CANCELLED, 'cancelled_by' => $by->id, 'cancelled_at' => now(), 'revision' => $b->revision + 1, 'updated_at' => now()]);
        if ($moved !== 1) {
            throw self::wrongState();
        }
        $this->audit->log('platform_sms_broadcast.cancelled', $b, ['name' => $b->name], $by, tenantId: false, platform: true);

        return self::locate($b->id);
    }

    /**
     * "Send test to me" with the test opt-out code (§7.5).
     *
     * @return array<string, mixed> PlatformSmsTestResult
     */
    public function test(string $language, string $phone, string $bodyBn, string $bodyEn, User $by): array
    {
        $msisdn = SmsProviderService::phone($phone);
        $body = BroadcastTexts::validate($language === 'en' ? $bodyEn : $bodyBn, $language, $language === 'en' ? 'body_en' : 'body_bn');
        $text = BroadcastTexts::text($body, $language, PlatformSmsTemplates::sampleVars($language), BroadcastTexts::TEST_CODE);
        $result = $this->types->sendTest($msisdn, $text, SmsRoute::Promotional);
        $this->audit->log('platform_sms.test_sent', null, ['type' => 'broadcast', 'language' => $language, 'to_masked' => $result['to_masked'],
            'status' => $result['status']], $by, tenantId: false, platform: true);

        return $result;
    }

    private static function scheduledAt(mixed $value): ?Carbon
    {
        return $value === null || $value === '' ? null : Carbon::parse((string) $value)->utc();
    }

    private static function wrongState(): ApiException
    {
        return new ApiException(409, 'invalid_state_transition', 'This broadcast can’t be changed in its current state.');
    }

    private static function revisionConflict(): ApiException
    {
        return new ApiException(409, 'revision_conflict', 'This broadcast was changed by someone else. Reload and try again.');
    }
}
