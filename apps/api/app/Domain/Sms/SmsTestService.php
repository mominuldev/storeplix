<?php

declare(strict_types=1);

namespace App\Domain\Sms;

use App\Domain\Identity\Models\User;
use App\Domain\Orders\Notifications\SmsTemplates;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Support\Phone;
use App\Domain\Sms\Charging\SmsCharger;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/**
 * PHASE-8-9A §6.2 (P89A-2, S218): "Send test SMS" — a fixed text to the ACTING member's verified phone only (no `to`
 * accepted), synchronous, charged like any transactional SMS, audited `sms.test_sent` (masked phone, parts, source).
 */
final class SmsTestService
{
    public function __construct(
        private readonly SmsCharger $charger,
        private readonly SmsGateway $gateway,
        private readonly AuditLogger $audit,
    ) {}

    /** @return array{sms_message_id: string, to_masked: string, status: string, charged_from: string|null, parts: int} */
    public function send(Store $store, User $user, ?string $language): array
    {
        $to = $user->phone_verified_at !== null ? Phone::bdMsisdn($user->phone) : null;
        if ($to === null) {
            throw new ApiException(422, 'phone_not_verified', 'Verify your phone number in your profile first.', ['phone' => ['Verify your phone number in your profile first.']]);
        }
        $language ??= StoreSetting::query()->where('store_id', $store->id)->value('sms_language') === 'en' ? 'en' : 'bn';
        $sender = SmsSender::for($store);
        $body = (string) config('sms.test_texts.'.$language);
        if ($sender !== null) {
            $body = SmsTemplates::dropShopPrefix($body);
        }
        $text = SmsTemplates::renderBody($body, ['shop' => SmsTemplates::clean($store->name, 40)]);

        [$message, $charge] = DB::transaction(function () use ($store, $to, $language, $sender, $text) {
            $message = SmsMessage::query()->create([
                'tenant_id' => $store->tenant_id, 'store_id' => $store->id, 'to' => $to, 'purpose' => SmsPurposes::SMS_TEST,
                'template' => SmsPurposes::SMS_TEST.'.'.$language, 'status' => SmsMessage::QUEUED, 'sender_id' => $sender,
            ]);

            return [$message, $this->charger->charge($message, $text)];
        });
        if ($charge->skipped()) {
            throw SmsCharger::exhausted($charge);
        }
        try {
            $result = $this->gateway->send($to, $text, $sender);
        } catch (SmsSendFailed $e) {
            $message->markFailed(Str::limit($e->getMessage(), 250));
            $this->charger->refund($message);

            throw new ApiException(502, 'provider_error', 'The SMS provider could not send the test SMS. Try again in a moment.');
        }
        $message->markSent($result->message_id);
        $masked = SmsPreview::maskPhone($to);
        $this->audit->log('sms.test_sent', $message, ['to_masked' => $masked, 'parts' => $charge->parts, 'charged_from' => $charge->from, 'store_id' => $store->id], $user);

        return ['sms_message_id' => $message->id, 'to_masked' => $masked, 'status' => SmsMessage::SENT, 'charged_from' => $charge->from, 'parts' => $charge->parts];
    }
}
