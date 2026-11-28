<?php

declare(strict_types=1);

namespace App\Domain\Sms\Platform;

use App\Domain\Identity\Models\User;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Sms\Models\PlatformSmsBroadcast;
use App\Domain\Sms\Models\PlatformSmsMessageTypeSetting;
use App\Domain\Sms\Models\PlatformSmsTemplate;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\Models\SmsProvider;
use App\Domain\Sms\Providers\SmsProviderService;
use App\Domain\Sms\Routing\RoutingSmsGateway;
use App\Domain\Sms\Routing\SmsRoutingTable;
use App\Domain\Sms\SmsGateway;
use App\Domain\Sms\SmsPreview;
use App\Domain\Sms\SmsRoute;
use App\Domain\Sms\SmsSendFailed;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\Support\PlatformDb;
use Illuminate\Support\Carbon;

/**
 * PHASE-8-9B §6: the message-types tab — catalogue + KPIs + group meta, the on/off switches (P89B-15), template edit /
 * reset (P89B-14, revision), preview and "Send test to me" (P89B-26: a typed phone, synchronous, `platform_test` row).
 * Writes on the platform connection; every write audited with the platform actor.
 */
final class PlatformSmsMessageTypes
{
    public function __construct(
        private readonly AuditLogger $audit,
        private readonly SmsRoutingTable $table,
    ) {}

    public static function type(string $value): PlatformSmsType
    {
        return PlatformSmsType::tryFrom($value) ?? throw new ApiException(404, 'not_found', 'Resource not found.');
    }

    /** @return array{data: list<array<string, mixed>>, meta: array<string, mixed>} */
    public function list(): array
    {
        $start = self::monthStart();
        $db = PlatformDb::connection(); // cross-tenant: platform SMS KPIs (platform rows only)
        $perPurpose = $db->table('sms_messages')->whereNull('tenant_id')->where('status', SmsMessage::SENT)->where('created_at', '>=', $start)
            ->selectRaw('purpose, count(*) as c')->groupBy('purpose')->pluck('c', 'purpose');
        $customs = PlatformSmsTemplate::query()->get()->keyBy(fn (PlatformSmsTemplate $t) => $t->type.'.'.$t->language);
        $data = [];
        foreach (PlatformSmsType::cases() as $type) {
            $data[] = $this->present($type, (int) ($perPurpose[$type->purpose()] ?? 0), $customs->all());
        }

        return ['data' => $data, 'meta' => ['kpis' => $this->kpis($start), 'groups' => $this->groups()]];
    }

    /**
     * PlatformSmsMessageType.
     *
     * @param  array<string, PlatformSmsTemplate>|null  $customs
     * @return array<string, mixed>
     */
    public function present(PlatformSmsType $type, ?int $sentThisMonth = null, ?array $customs = null): array
    {
        $sentThisMonth ??= (int) PlatformDb::connection()->table('sms_messages')->whereNull('tenant_id')->where('status', SmsMessage::SENT)
            ->where('purpose', $type->purpose())->where('created_at', '>=', self::monthStart())->count();
        $templates = [];
        if ($type !== PlatformSmsType::Broadcast) {
            foreach (PlatformSmsTemplates::LANGUAGES as $language) {
                $row = $customs !== null ? ($customs[$type->value.'.'.$language] ?? null) : null;
                $templates[] = PlatformSmsTemplates::present($type, $language, $row, $customs === null);
            }
        }

        return [
            'type' => $type->value,
            'group' => $type->group(),
            'label' => $type->label(),
            'trigger' => $type->trigger(),
            'locked' => $type->locked(),
            'editable' => $type->editable(),
            'enabled' => $type->locked() ? null : PlatformSmsTemplates::enabled($type),
            'sender' => $type->sender(),
            'merge_fields' => $type->mergeFields(),
            'required_fields' => $type->requiredFields(),
            'templates' => $templates,
            'sent_this_month' => $sentThisMonth,
        ];
    }

    public function toggle(PlatformSmsType $type, bool $enabled, User $by): array
    {
        if ($type->locked()) {
            throw new ApiException(422, 'platform_sms_type_locked', 'Account codes are always sent and can’t be switched off.');
        }
        $from = PlatformSmsTemplates::enabled($type);
        if ($type === PlatformSmsType::Broadcast && ! $enabled
            && PlatformDb::reroute(PlatformSmsBroadcast::query())->whereIn('status', [PlatformSmsBroadcast::SCHEDULED, PlatformSmsBroadcast::SENDING])->exists()) {
            throw new ApiException(409, 'broadcasts_pending', 'Cancel or finish the scheduled broadcasts before turning broadcasts off.');
        }
        PlatformDb::reroute(PlatformSmsMessageTypeSetting::query())->updateOrCreate(['type' => $type->value], ['enabled' => $enabled, 'updated_by' => $by->id, 'updated_at' => now()]);
        $setting = (new PlatformSmsMessageTypeSetting)->forceFill(['type' => $type->value]);
        $this->audit->log('platform_sms_type.updated', $setting, ['type' => $type->value, 'enabled' => ['from' => $from, 'to' => $enabled]], $by, tenantId: false, platform: true);

        return $this->present($type);
    }

    /** @return array<string, mixed> PlatformSmsTemplate */
    public function updateTemplate(PlatformSmsType $type, string $language, string $body, int $revision, User $by): array
    {
        PlatformSmsTemplates::assertEditable($type);
        $valid = PlatformSmsTemplates::validate($type, $language, $body);
        $query = fn () => PlatformDb::reroute(PlatformSmsTemplate::query())->where('type', $type->value)->where('language', $language);
        $row = $query()->first();
        if ($revision !== ($row?->revision ?? 0)) {
            throw new ApiException(409, 'revision_conflict', 'This text was changed by someone else. Reload and try again.');
        }
        $oldLength = mb_strlen($row?->body ?? PlatformSmsTemplates::defaultBody($type, $language));
        if ($valid['body'] === PlatformSmsTemplates::defaultBody($type, $language)) {
            $query()->delete(); // saving the default = reset
        } elseif ($row === null) {
            $row = PlatformDb::reroute(PlatformSmsTemplate::query())->create(['type' => $type->value, 'language' => $language, 'body' => $valid['body'],
                'revision' => 1, 'updated_by' => $by->id]);
        } else {
            $moved = $query()->where('revision', $revision)->update(['body' => $valid['body'], 'revision' => $revision + 1, 'updated_by' => $by->id, 'updated_at' => now()]);
            if ($moved !== 1) {
                throw new ApiException(409, 'revision_conflict', 'This text was changed by someone else. Reload and try again.');
            }
        }
        $subject = $row ?? (new PlatformSmsTemplate)->forceFill(['type' => $type->value]);
        $this->audit->log('platform_sms_template.updated', $subject, ['type' => $type->value, 'language' => $language,
            'length' => ['from' => $oldLength, 'to' => mb_strlen($valid['body'])]], $by, tenantId: false, platform: true);

        return PlatformSmsTemplates::present($type, $language);
    }

    /** @return array<string, mixed> PlatformSmsTemplate (the default) — idempotent */
    public function resetTemplate(PlatformSmsType $type, string $language, User $by): array
    {
        PlatformSmsTemplates::assertEditable($type);
        $row = PlatformDb::reroute(PlatformSmsTemplate::query())->where('type', $type->value)->where('language', $language)->first();
        if ($row !== null) {
            PlatformDb::reroute(PlatformSmsTemplate::query())->whereKey($row->id)->delete();
            $this->audit->log('platform_sms_template.reset', $row, ['type' => $type->value, 'language' => $language], $by, tenantId: false, platform: true);
        }

        return PlatformSmsTemplates::present($type, $language);
    }

    /** @return array{text: string, parts: int, encoding: string, characters: int} */
    public function preview(PlatformSmsType $type, string $language, string $body): array
    {
        if ($type->locked()) {
            PlatformSmsTemplates::assertEditable($type);
        }

        return PlatformSmsTemplates::validate($type, $language, $body)['preview'];
    }

    /** @return array<string, mixed> PlatformSmsTestResult */
    public function test(PlatformSmsType $type, string $language, string $phone, ?string $body, User $by): array
    {
        if ($type === PlatformSmsType::Broadcast) {
            throw new ApiException(422, 'platform_sms_type_locked', 'Test a broadcast from the Broadcasts tab.');
        }
        $msisdn = SmsProviderService::phone($phone);
        $vars = PlatformSmsTemplates::sampleVars($language);
        if ($type->locked()) {
            $text = PlatformSmsTemplates::render(PlatformSmsTemplates::defaultBody($type, 'en'), $vars);
        } else {
            $source = $body !== null && trim($body) !== '' ? PlatformSmsTemplates::validate($type, $language, $body)['body'] : PlatformSmsTemplates::body($type, $language);
            $text = PlatformSmsTemplates::render($source, $vars);
        }
        $result = $this->sendTest($msisdn, $text, $type->route(), $type->locked() ? null : PlatformSmsType::TEST_PURPOSE);
        $this->audit->log('platform_sms.test_sent', null, ['type' => $type->value, 'language' => $language, 'to_masked' => $result['to_masked'],
            'status' => $result['status']], $by, tenantId: false, platform: true);

        return $result;
    }

    /**
     * A synchronous admin test through the router (`platform_test` row; codes never get a preview).
     *
     * @return array{sms_message_id: string, status: string, to_masked: string, parts: int, provider: array{id: string|null, name: string}|null}
     */
    public function sendTest(string $msisdn, string $text, SmsRoute $route, ?string $previewPurpose = PlatformSmsType::TEST_PURPOSE, ?string $previewText = null): array
    {
        $parts = PlatformSmsTemplates::count($text)['parts'];
        $message = PlatformSmsDelivery::query()->create([
            'tenant_id' => null, 'to' => $msisdn, 'purpose' => PlatformSmsType::TEST_PURPOSE, 'template' => 'platform:test.'.$route->value,
            'status' => SmsMessage::QUEUED, 'parts' => $parts,
            'body_preview' => $previewPurpose !== null ? SmsPreview::of($previewPurpose, $previewText ?? $text) : null,
        ]);
        $providerId = null;
        try {
            $result = app(SmsGateway::class)->send($msisdn, $text, null, $route);
            PlatformSmsDelivery::markSent($message->id, $result);
            $providerId = $result->provider_id;
            $status = SmsMessage::SENT;
        } catch (SmsSendFailed $e) {
            PlatformSmsDelivery::markFailed($message->id, $e);
            $providerId = $e->providerId;
            $status = SmsMessage::FAILED;
        }

        return ['sms_message_id' => $message->id, 'status' => $status, 'to_masked' => SmsPreview::maskPhone($msisdn), 'parts' => $parts,
            'provider' => $this->providerRef($providerId)];
    }

    /** @return array{id: string|null, name: string}|null */
    public function providerRef(?string $providerId): ?array
    {
        if ($providerId !== null) {
            $name = SmsProvider::query()->whereKey($providerId)->value('name');

            return $name !== null ? ['id' => $providerId, 'name' => (string) $name] : null;
        }

        return ['id' => null, 'name' => match ((string) config('sms.driver')) {
            'log' => 'Log driver (development)',
            'fake' => 'Fake driver (tests)',
            default => 'REVE SMS (server environment)',
        }];
    }

    /** @return array{sent_this_month: int, codes_this_month: int, promotional_this_month: int, cost_this_month_paisa: int} */
    private function kpis(Carbon $start): array
    {
        $db = PlatformDb::connection(); // cross-tenant: platform SMS KPIs (platform rows only)
        $base = fn () => $db->table('sms_messages')->whereNull('tenant_id')->where('status', SmsMessage::SENT)->where('created_at', '>=', $start);
        $byProvider = $base()->selectRaw('provider_id, sum(parts) as p')->groupBy('provider_id')->pluck('p', 'provider_id');
        $prices = SmsProvider::query()->whereIn('id', $byProvider->keys()->filter()->all())->pluck('price_masking_paisa', 'id');
        $envPrice = (int) config('sms.drivers.revesms.price_masking_paisa', 0);
        $cost = 0;
        foreach ($byProvider as $id => $parts) {
            $cost += (int) $parts * (int) ($id !== null && $id !== '' ? ($prices[$id] ?? 0) : $envPrice);
        }

        return [
            'sent_this_month' => $base()->count(),
            'codes_this_month' => $base()->whereIn('purpose', self::codePurposes())->count(),
            'promotional_this_month' => $base()->where('purpose', PlatformSmsType::Broadcast->purpose())->count(),
            'cost_this_month_paisa' => $cost,
        ];
    }

    /** @return list<array<string, mixed>> PlatformSmsGroupInfo */
    private function groups(): array
    {
        $router = app(RoutingSmsGateway::class);
        $out = [];
        foreach (['registration', 'billing', 'security', 'promotional'] as $group) {
            $route = SmsRoute::from($group);
            $carrier = $this->table->candidates($group)[0] ?? null;
            $out[] = [
                'group' => $group,
                'sender_id' => $carrier !== null ? ($route === SmsRoute::Promotional ? $carrier->promotionalSender : $router->senderFor($carrier, $route, null)) : null,
                'provider' => $carrier !== null ? ['id' => $carrier->id, 'name' => $carrier->name] : null,
                'rate_limit_per_minute' => $carrier?->rateLimitPerMinute,
            ];
        }

        return $out;
    }

    /** @return list<string> the `otp_*` purposes */
    public static function codePurposes(): array
    {
        return [PlatformSmsType::PhoneVerification->purpose(), PlatformSmsType::SignInCode->purpose(), PlatformSmsType::PasswordResetCode->purpose()];
    }

    /** Start of the current month in Asia/Dhaka, as UTC. */
    public static function monthStart(): Carbon
    {
        return now()->timezone((string) config('sms.platform.timezone', 'Asia/Dhaka'))->startOfMonth()->utc();
    }
}
