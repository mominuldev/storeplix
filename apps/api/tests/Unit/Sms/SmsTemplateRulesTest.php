<?php

declare(strict_types=1);

namespace Tests\Unit\Sms;

use App\Domain\Orders\Notifications\SmsTemplates;
use App\Domain\Sms\SmsPreview;
use App\Domain\Sms\Templates\SmsTemplateCatalog;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/** PHASE-8-9A §7.1, P89A-8, P89A-21 (S214, S217): template catalogue, normalising, previews and masking. */
#[Group('sms')]
class SmsTemplateRulesTest extends TestCase
{
    public function test_catalogue_covers_every_key_and_the_figma_tags_are_unknown(): void
    {
        $this->assertSame([...SmsTemplates::EDITABLE, 'checkout_otp'], SmsTemplateCatalog::KEYS);
        foreach (SmsTemplateCatalog::KEYS as $key) {
            foreach (['bn', 'en'] as $language) {
                preg_match_all('/\{([^{}]*)\}/u', SmsTemplates::defaultBody($key, $language), $m);
                $this->assertSame([], array_diff($m[1], SmsTemplateCatalog::MERGE_FIELDS[$key]), "{$language}.{$key} default uses only its merge fields");
            }
        }
        foreach (['name', 'order_no', 'otp', 'pay_link', 'track_link', 'review_link'] as $figma) {
            foreach (SmsTemplateCatalog::MERGE_FIELDS as $fields) {
                $this->assertNotContains($figma, $fields);
            }
        }
        $this->assertTrue(SmsTemplateCatalog::editable('pos_receipt'));
        $this->assertFalse(SmsTemplateCatalog::editable('checkout_otp'));
        $this->assertFalse(SmsTemplateCatalog::exists('delivered'));
    }

    public function test_normalise_collapses_line_breaks_and_trims(): void
    {
        $this->assertSame('{shop}: Hi {first_name} Bye', SmsTemplateCatalog::normalise("  {shop}: Hi {first_name}\r\n\nBye "));
    }

    public function test_preview_hides_links_and_codes_and_masks_phones(): void
    {
        $this->assertSame('Shop: Pay Tk 500: [link]', SmsPreview::of('payment_link', 'Shop: Pay Tk 500: https://shop.example/pay/AbCdEf123'));
        $this->assertSame('Hi STOP: [link]', SmsPreview::of('campaign', "Hi\nSTOP: shop.storeplix.com/u/abc123"));
        $this->assertNull(SmsPreview::of('checkout_otp', 'Your code is 482913'));
        $this->assertNull(SmsPreview::of('otp_login', 'Your code is 482913'));
        $this->assertSame(160, mb_strlen((string) SmsPreview::of('order_placed', str_repeat('a', 300))));
        $this->assertSame('01711-•••211', SmsPreview::maskPhone('8801711552211'));
        $this->assertSame('01711-•••211', SmsPreview::maskPhone('01711552211'));
    }

    public function test_default_texts_render_byte_for_byte_like_8_8d(): void
    {
        $vars = ['first_name' => 'Farhana', 'shop' => 'Gallery', 'number' => 'GS-1042', 'total' => '1,770', 'due' => '1,770', 'carrier' => 'Steadfast',
            'track_url' => 'https://gallery.storeplix.com/track', 'amount' => '500', 'url' => 'https://gallery.storeplix.com/pay/Ab12', 'method' => 'Cash', 'footer' => 'Thanks', 'code' => '482913'];
        foreach (['bn', 'en'] as $language) {
            foreach (SmsTemplateCatalog::KEYS as $key) {
                $expected = trim((string) preg_replace('/\s+/u', ' ', strtr(SmsTemplates::defaultBody($key, $language),
                    array_combine(array_map(fn ($k) => '{'.$k.'}', array_keys($vars)), array_values($vars)))));
                $this->assertSame($expected, SmsTemplates::render($key, $language, $vars), "{$language}.{$key}");
            }
        }
    }
}
