<?php

declare(strict_types=1);

namespace App\Domain\Inbox;

use App\Domain\Inbox\Models\InboxConversation;
use App\Domain\Marketing\Content\SmsParts;
use App\Domain\Marketing\Sending\DevMessageSink;
use App\Domain\Orders\Notifications\SmsTemplates;
use App\Domain\Sms\Charging\SmsCharger;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\SmsGateway;
use App\Domain\Sms\SmsPurposes;
use App\Domain\Sms\SmsRoute;
use App\Domain\Sms\SmsSender;
use App\Domain\Sms\SmsSendFailed;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Support\Str;

/**
 * The two Inbox SMS (PHASE-8-8E P88E-11/12, S238/S239): every one is a `sms_messages` row charged through SmsCharger
 * (8.9a §4) before the provider call, sent on route `shop` with the store's sender ID (P89A-17 prefix rule). The chat
 * code text lives only in memory (body_preview null); the reply SMS preview shows its link as `[link]`. Fixed bn/en
 * texts (resources/sms, keys `inbox_verify` / `inbox_reply`), not editable in 8.8e. Inside the tenant context.
 */
final class InboxSms
{
    public function __construct(
        private readonly SmsCharger $charger,
        private readonly SmsGateway $gateway,
        private readonly TenantContext $context,
    ) {}

    public static function language(string $storeId): string
    {
        return StoreSetting::query()->where('store_id', $storeId)->value('sms_language') === 'en' ? 'en' : 'bn';
    }

    /** @param array<string, string> $vars */
    public static function text(Store $store, string $key, string $language, array $vars): string
    {
        $body = SmsTemplates::defaultBody($key, $language);
        if (SmsSender::for($store) !== null) {
            $body = SmsTemplates::dropShopPrefix($body);
        }

        return SmsTemplates::renderBody($body, ['shop' => SmsTemplates::clean($store->name, 40)] + $vars);
    }

    /**
     * P88E-11: sends the 6-digit chat code now. False when the allowance / credits can't pay it or the provider fails:
     * the caller falls back to an unverified conversation (P88E-14). The same answer for every number (no oracle).
     */
    public function sendCode(Store $store, string $phone, string $code): bool
    {
        $language = self::language($store->id);
        $text = self::text($store, SmsPurposes::INBOX_VERIFY, $language, ['code' => $code]);
        if (! $this->charger->canAfford(SmsPurposes::TRANSACTIONAL, SmsParts::partsOf($text))) {
            return false;
        }
        $sender = SmsSender::for($store);
        $message = DB::transaction(function () use ($store, $phone, $language, $text, $sender) {
            $message = SmsMessage::query()->create([
                'tenant_id' => $this->context->requireId(),
                'store_id' => $store->id,
                'to' => $phone,
                'purpose' => SmsPurposes::INBOX_VERIFY,
                'template' => SmsPurposes::INBOX_VERIFY.'.'.$language,
                'status' => SmsMessage::QUEUED,
                'sender_id' => $sender,
            ]);

            return $this->charger->charge($message, $text)->skipped() ? null : $message;
        });
        if ($message === null) {
            return false;
        }

        return $this->deliver($message, $text, $sender, $store->id, SmsPurposes::INBOX_VERIFY);
    }

    /**
     * P88E-12: the "shop replied" SMS for a conversation (called by SendInboxReplySms, outside the conversation lock for
     * the provider call). Returns `sent` | `no_credits` | `failed`.
     */
    public function sendReply(Store $store, InboxConversation $conversation, string $url): string
    {
        $language = self::language($store->id);
        $text = self::text($store, SmsPurposes::INBOX_REPLY, $language, ['url' => $url]);
        $sender = SmsSender::for($store);
        $message = DB::transaction(function () use ($store, $conversation, $language, $text, $sender) {
            $message = SmsMessage::query()->create([
                'tenant_id' => $this->context->requireId(),
                'store_id' => $store->id,
                'to' => (string) $conversation->contact_phone,
                'purpose' => SmsPurposes::INBOX_REPLY,
                'template' => SmsPurposes::INBOX_REPLY.'.'.$language,
                'status' => SmsMessage::QUEUED,
                'sender_id' => $sender,
                'reference_type' => 'conversation',
                'reference_id' => $conversation->id,
            ]);

            return $this->charger->charge($message, $text)->skipped() ? null : $message;
        });
        if ($message === null) {
            return 'no_credits';
        }

        return $this->deliver($message, $text, $sender, $store->id, SmsPurposes::INBOX_REPLY) ? 'sent' : 'failed';
    }

    private function deliver(SmsMessage $message, string $text, ?string $sender, string $storeId, string $kind): bool
    {
        try {
            $result = $this->gateway->send($message->to, $text, $sender, SmsRoute::Shop);
            $message->markSent($result->message_id, $result);
        } catch (SmsSendFailed $e) {
            $message->markFailed(Str::limit($e->getMessage(), 250), $e);
            $this->charger->refund($message);
            Log::warning('inbox.sms_failed', ['store_id' => $storeId, 'purpose' => $kind]);

            return false;
        }
        // Testing-only sink (never in production): e2e reads the code / link from here; no API response carries them.
        DevMessageSink::record($storeId, ['channel' => 'sms', 'to' => $message->to, 'subject' => null, 'text' => $text,
            'unsubscribe_url' => '', 'campaign_id' => null, 'is_test' => false, 'kind' => $kind]);

        return true;
    }
}
