<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\Charging;

use App\Domain\Billing\Models\Plan;
use App\Domain\Orders\Models\OrderEvent;
use App\Domain\Orders\Notifications\SendOrderSms;
use App\Domain\Orders\Notifications\SmsTemplates;
use App\Domain\Sms\Models\SmsCreditLedgerEntry;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\SmsGateway;
use App\Domain\Sms\SmsSendFailed;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Mail;
use PHPUnit\Framework\Attributes\Group;
use Tests\Support\CommerceFixtures;
use Tests\TestCase;

/**
 * PHASE-8-9A §4.3 / §4.4 for order SMS: after the allowance the SMS is paid with credits (log row charged_from
 * credits), with neither it is skipped with a log row and the new timeline wording, a provider failure refunds; the
 * default texts are byte for byte the 8.8d texts.
 */
#[Group('sms')]
class SmsOrderSendersTest extends TestCase
{
    use CommerceFixtures, RefreshDatabase, SmsChargingFixtures;

    protected function setUp(): void
    {
        parent::setUp();
        $this->withoutMiddleware(ThrottleRequests::class);
        Mail::fake();
    }

    public function test_order_sms_uses_credits_after_the_allowance_then_skips_and_refunds_failures(): void
    {
        [, $tenant, $store, $h] = $this->liveShop();
        [, $variant] = $this->stocked($h, $store, 1000, 50);
        $this->smsPlan($tenant, Plan::STARTER, 1, 1000);
        $this->usedSms($tenant, 1);
        $this->giveCredits($tenant, 10);

        $id = $this->manual($h, $store, $this->manualBody($variant))->assertCreated()->json('data.id');
        $this->assertCount(1, app(SmsGateway::class)->sent);
        $row = $this->platformQuery(SmsMessage::class)->where('tenant_id', $tenant->id)->where('purpose', 'order_placed')->whereNotNull('store_id')->sole();
        $this->assertSame(['sent', 'credits', $store->id, 'order', $id, 'transactional'], [$row->status, $row->charged_from, $row->store_id, $row->reference_type, $row->reference_id, $row->kind]);
        $this->assertSame(10 - $row->parts, $this->balance($tenant));
        $this->assertSame($row->parts, $row->credits_charged);
        $this->assertNotNull($row->sent_at);
        $this->assertStringContainsString('[link]', (string) $row->body_preview, 'the tracking link is never stored');

        // A provider failure refunds that attempt's credits (the retry is a new row).
        app(SmsGateway::class)->failNext = true;
        try {
            dispatch((new SendOrderSms($id, 'order_cancelled'))->forTenant($tenant->id));
            $this->fail('the failed send throws for a retry');
        } catch (SmsSendFailed) {
        }
        $failed = $this->platformQuery(SmsMessage::class)->where('tenant_id', $tenant->id)->where('purpose', 'order_cancelled')->sole();
        $this->assertSame(['failed', 'provider_error'], [$failed->status, $failed->error_code]);
        $this->assertSame(10 - $row->parts, $this->balance($tenant), 'refunded');
        $this->inTenant($tenant, fn () => $this->assertSame(1, SmsCreditLedgerEntry::query()->where('sms_message_id', $failed->id)->where('type', 'refund')->count()));

        // No credits left → skipped with a log row and the new note.
        $this->giveCredits($tenant, -$this->balance($tenant));
        dispatch((new SendOrderSms($id, 'order_confirmed'))->forTenant($tenant->id));
        $skipped = $this->platformQuery(SmsMessage::class)->where('tenant_id', $tenant->id)->where('purpose', 'order_confirmed')->sole();
        $this->assertSame(['skipped', 'no_credits'], [$skipped->status, $skipped->error_code]);
        $note = $this->inTenant($tenant, fn () => OrderEvent::query()->where('order_id', $id)->where('type', 'notification')->orderByDesc('created_at')->orderByDesc('id')->get()
            ->first(fn ($e) => ($e->meta['event'] ?? null) === 'order_confirmed'));
        $this->assertSame('SMS not sent: monthly SMS allowance and SMS credits used up', $note->body);
        $this->assertSame('skipped', $note->meta['status']);
        $this->assertCount(1, app(SmsGateway::class)->sent);
        $this->assertLedgerMatches($tenant);
    }

    /** P89A-11 / AC 1: with no custom template and the shared sender every default renders exactly as in 8.8d. */
    public function test_default_texts_are_byte_for_byte_the_previous_renderer(): void
    {
        [, $tenant, $store] = $this->liveShop();
        $sets = [
            ['first_name' => 'Farhana', 'shop' => 'Gallery Shop', 'number' => 'GS-1042', 'total' => '12,500', 'due' => '12,500', 'carrier' => 'Steadfast',
                'track_url' => 'https://gallery.storeplix.com/track', 'amount' => '500', 'url' => 'https://gallery.storeplix.com/pay/AbCd', 'method' => 'Cash', 'footer' => 'Thank you', 'code' => '482913'],
            ['first_name' => str_repeat('ন', 20), 'shop' => str_repeat('S', 40), 'number' => 'ABCDEF-1234567', 'total' => '1,000,000', 'due' => '1,000,000',
                'carrier' => str_repeat('C', 30), 'track_url' => 'https://'.str_repeat('a', 40).'.storeplix.com/track', 'amount' => '1,000,000',
                'url' => 'https://'.str_repeat('a', 40).'.storeplix.com/pay/AbCdEfGh1234', 'method' => 'Cash + bKash + Card', 'footer' => str_repeat('F', 120), 'code' => '000001'],
        ];
        foreach (['bn', 'en'] as $language) {
            foreach ([...SmsTemplates::EDITABLE, SmsTemplates::CHECKOUT_OTP] as $key) {
                foreach ($sets as $vars) {
                    $expected = self::legacyRender($key, $language, $vars);
                    $this->assertSame($expected, SmsTemplates::render($key, $language, $vars), "{$language}.{$key}");
                    $this->assertSame($expected, $this->inTenant($tenant, fn () => SmsTemplates::render($key, $language, $vars, $store)), "{$language}.{$key} (store)");
                }
            }
        }
    }

    /** The 8.8d SmsTemplates::render, verbatim (201-character target). @param array<string, string> $vars */
    private static function legacyRender(string $event, string $language, array $vars): string
    {
        $templates = require resource_path('sms/'.($language === 'en' ? 'en' : 'bn').'.php');
        $template = $templates[$event];
        $fill = function (string $template, array $vars): string {
            $replace = [];
            foreach ($vars as $key => $value) {
                $replace['{'.$key.'}'] = $value;
            }

            return trim((string) preg_replace('/\s+/u', ' ', strtr($template, $replace)));
        };
        $minimum = ['footer' => 0, 'first_name' => 0, 'carrier' => 8, 'shop' => 12];
        for ($i = 0; $i < 10; $i++) {
            $text = $fill($template, $vars);
            $over = mb_strlen($text) - 201;
            if ($over <= 0) {
                return $text;
            }
            foreach ($minimum as $key => $min) {
                if (! isset($vars[$key]) || ! str_contains($template, '{'.$key.'}') || mb_strlen($vars[$key]) <= $min) {
                    continue;
                }
                $cut = min($over, mb_strlen($vars[$key]) - $min);
                $vars[$key] = trim(mb_substr($vars[$key], 0, mb_strlen($vars[$key]) - $cut));
                $over -= $cut;
                if ($over <= 0) {
                    break;
                }
            }
        }

        return $fill($template, $vars);
    }
}
