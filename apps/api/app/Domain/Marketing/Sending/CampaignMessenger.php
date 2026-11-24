<?php

declare(strict_types=1);

namespace App\Domain\Marketing\Sending;

use App\Domain\Marketing\Content\StoreBrand;
use App\Domain\Sms\Drivers\FakeSmsGateway;
use App\Domain\Sms\Drivers\LogSmsGateway;
use App\Domain\Sms\SmsGateway;
use App\Domain\Sms\SmsSendFailed;
use App\Domain\Tenancy\Support\TenantCache;
use Illuminate\Mail\Message;
use Illuminate\Support\Facades\Mail;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\HtmlString;
use Illuminate\Support\Sleep;
use RuntimeException;
use Throwable;

/**
 * Provider calls for campaign messages (PHASE-8-5 §5.1 step 3, §5.4). SMS through the existing SmsGateway; email
 * through the dedicated `campaigns` mailer. Throughput P85-12: limiter slots per second (store SMS, platform SMS, store
 * email); a full second waits (Sleep, fakeable) rather than failing.
 *
 * Production safety: campaign traffic never goes through the log/fake SMS drivers or a log/array mailer in production
 * (the boot guard catches the obvious misconfigurations; this is the last line).
 */
final class CampaignMessenger
{
    public function __construct(private readonly SmsGateway $sms) {}

    /** @return string|null provider message id @throws CampaignSendFailed */
    public function sms(string $storeId, string $msisdn, string $text): ?string
    {
        if (app()->environment('production') && ($this->sms instanceof LogSmsGateway || $this->sms instanceof FakeSmsGateway)) {
            throw new CampaignSendFailed('provider_error', 'Campaign SMS refuse the log/fake driver in production.');
        }
        $this->slot(app(TenantCache::class)->key('campaigns-sms:'.$storeId), (int) config('campaigns.sms_rate_per_second', 10));
        $this->slot('campaigns-sms:platform', (int) config('campaigns.platform_sms_rate_per_second', 50));
        try {
            $result = $this->sms->send($msisdn, $text);
        } catch (SmsSendFailed $e) {
            throw new CampaignSendFailed('provider_error', $e->getMessage());
        }
        if (! $result->accepted) {
            throw new CampaignSendFailed('provider_error', 'The SMS provider did not accept the message.');
        }

        return $result->message_id;
    }

    /**
     * @param  array{subject: string, html: string, text: string, unsubscribe_url: string, one_click_url: string}  $email
     *
     * @throws CampaignSendFailed
     */
    public function email(StoreBrand $store, string $to, array $email): ?string
    {
        $mailer = (string) config('campaigns.mailer', 'campaigns');
        $transport = (string) config("mail.mailers.{$mailer}.transport");
        if (app()->environment('production') && in_array($transport, ['log', 'array'], true)) {
            throw new CampaignSendFailed('provider_error', 'Campaign email refuses the log/array mailer in production.');
        }
        if (filter_var($to, FILTER_VALIDATE_EMAIL) === false) {
            throw new CampaignSendFailed('invalid_address', 'Invalid email address.');
        }
        $this->slot(app(TenantCache::class)->key('campaigns-email:'.$store->storeId), (int) config('campaigns.email_rate_per_second', 20));
        $messageId = null;
        try {
            $sent = Mail::mailer($mailer)->send(
                ['html' => new HtmlString($email['html']), 'text' => new HtmlString($email['text'])],
                [],
                function (Message $message) use ($store, $to, $email) {
                    $message->from((string) config('campaigns.mail_from'), self::displayName($store->name));
                    $message->to($to);
                    if ($store->contactEmail !== null && filter_var($store->contactEmail, FILTER_VALIDATE_EMAIL) !== false) {
                        $message->replyTo($store->contactEmail);
                    }
                    $message->subject($email['subject']);
                    $headers = $message->getSymfonyMessage()->getHeaders();
                    $headers->addTextHeader('List-Unsubscribe', '<'.$email['one_click_url'].'>');
                    $headers->addTextHeader('List-Unsubscribe-Post', 'List-Unsubscribe=One-Click');
                },
            );
            $messageId = $sent?->getMessageId();
        } catch (Throwable $e) {
            throw new CampaignSendFailed('provider_error', $e->getMessage());
        }

        return $messageId !== null ? substr($messageId, 0, 128) : null;
    }

    /** Waits for a free slot of `$perSecond` messages per second under `$key`. */
    private function slot(string $key, int $perSecond): void
    {
        if ($perSecond <= 0) {
            return;
        }
        for ($i = 0; $i < 50; $i++) {
            if (RateLimiter::attempt($key, $perSecond, fn () => true, 1)) {
                return;
            }
            Sleep::for(max(50, RateLimiter::availableIn($key) * 1000))->milliseconds();
        }

        throw new RuntimeException('Campaign throughput limiter did not free a slot.');
    }

    private static function displayName(string $name): string
    {
        return trim((string) preg_replace('/[\x00-\x1F\x7F"<>]/u', ' ', $name)) ?: 'Store';
    }
}
