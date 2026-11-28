<?php

declare(strict_types=1);

namespace App\Domain\Sms;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Limit;
use App\Domain\Marketing\CampaignAllowance;
use App\Domain\Sms\Credits\SmsCreditService;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\Models\SmsSenderId;
use App\Domain\Sms\SenderIds\SenderIdPresenter;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Database\Eloquent\Builder;

/** SmsOverview (PHASE-8-9A §6.1, openapi 1.23.0). Inside the store's tenant context. */
final class SmsOverviewPresenter
{
    public function __construct(
        private readonly TenantContext $context,
        private readonly SmsCreditService $credits,
    ) {}

    /** @return array<string, mixed> */
    public function present(Store $store): array
    {
        $tenant = $this->context->tenant();
        $since = FeatureGate::monthStart();
        $rows = fn (): Builder => self::listed($store);
        $sent = (int) $rows()->where('status', SmsMessage::SENT)->where('created_at', '>=', $since)->count();
        $failed = (int) $rows()->where('status', SmsMessage::FAILED)->where('created_at', '>=', $since)->count();
        $first = $rows()->where('status', SmsMessage::SENT)->orderBy('created_at')->orderBy('id')->first(['sent_at', 'created_at']);
        $last = $rows()->where('status', SmsMessage::SENT)->orderByDesc('created_at')->orderByDesc('id')->first(['sent_at', 'created_at']);
        $sender = SmsSender::for($store);
        $pending = SmsSenderId::query()->where('store_id', $store->id)->where('status', SmsSenderId::PENDING)->with(['document', 'requestedBy'])->first();
        $txLimit = $tenant !== null ? FeatureGate::limit($tenant, Limit::SmsPerMonth) : 0;
        $mkLimit = $tenant !== null ? FeatureGate::limit($tenant, Limit::CampaignSmsPerMonth) : 0;
        $txUsed = $tenant !== null ? FeatureGate::usage($tenant, Limit::SmsPerMonth) : 0;
        $mkUsed = CampaignAllowance::used('sms');
        $can = fn (Permission ...$p) => $this->context->allowsAny(...$p);

        return [
            'gateway' => [
                'provider' => 'revesms',
                'name' => 'Storeplix SMS',
                'status' => 'connected',
                'active_since' => ($first?->sent_at ?? $first?->created_at)?->toIso8601ZuluString(),
                'last_sent_at' => ($last?->sent_at ?? $last?->created_at)?->toIso8601ZuluString(),
            ],
            'sender' => [
                'type' => $sender !== null ? 'masked' : 'shared',
                'sender_id' => $sender,
                'pending_request' => $pending !== null ? SenderIdPresenter::request($pending) : null,
            ],
            'language' => StoreSetting::query()->where('store_id', $store->id)->value('sms_language') === 'en' ? 'en' : 'bn',
            'allowance' => [
                'transactional' => self::usage($txLimit, $txUsed, 'messages'),
                'marketing' => self::usage($mkLimit, $mkUsed, 'parts'),
            ],
            'credits' => $this->credits->summary(),
            'this_month' => [
                'messages_sent' => $sent,
                'messages_failed' => $failed,
                'messages_skipped' => (int) $rows()->where('status', SmsMessage::SKIPPED)->where('created_at', '>=', $since)->count(),
                'sent_success_rate' => $sent + $failed > 0 ? round($sent / ($sent + $failed), 4) : null,
                'credits_used' => $this->credits->netConsumedSince($since),
                'otp_sent' => (int) $rows()->where('purpose', SmsPurposes::CHECKOUT_OTP)->where('status', SmsMessage::SENT)->where('created_at', '>=', $since)->count(),
            ],
            'quiet_hours' => [
                'from' => sprintf('%02d:00', (int) config('campaigns.quiet_from', 21)),
                'to' => sprintf('%02d:00', (int) config('campaigns.quiet_to', 9)),
                'timezone' => (string) ($store->timezone ?: 'Asia/Dhaka'),
            ],
            'can' => [
                'edit_templates' => $can(Permission::SettingsManage),
                'send_test' => $can(Permission::SettingsManage, Permission::IntegrationsManage),
                'view_log' => $can(Permission::SettingsManage, Permission::IntegrationsManage),
                'view_sender_ids' => $can(Permission::SettingsManage, Permission::IntegrationsManage),
                'request_sender_id' => $can(Permission::IntegrationsManage),
                'view_credit_history' => $can(Permission::BillingView),
                'buy_credits' => $can(Permission::BillingManage),
                'edit_low_credit_alert' => $can(Permission::BillingManage, Permission::SettingsManage),
            ],
        ];
    }

    /**
     * This store's merchant-visible rows (P89A-20): explicit tenant + store filters, account codes never included.
     *
     * @return Builder<SmsMessage>
     */
    public static function listed(Store $store): Builder
    {
        return SmsMessage::query()->where('tenant_id', app(TenantContext::class)->requireId())->where('store_id', $store->id)
            ->whereRaw("purpose NOT LIKE 'otp!_%' ESCAPE '!'")->whereIn('purpose', SmsPurposes::LISTED);
    }

    /** @return array{limit: int|null, used: int, remaining: int|null, unit: string} */
    private static function usage(?int $limit, int $used, string $unit): array
    {
        return ['limit' => $limit, 'used' => $used, 'remaining' => $limit === null ? null : max(0, $limit - $used), 'unit' => $unit];
    }
}
