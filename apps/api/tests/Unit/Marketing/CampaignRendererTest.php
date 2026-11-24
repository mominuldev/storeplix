<?php

declare(strict_types=1);

namespace Tests\Unit\Marketing;

use App\Domain\Marketing\Content\CampaignRenderer;
use App\Domain\Marketing\Content\MessageSpec;
use App\Domain\Marketing\Content\StoreBrand;
use App\Domain\Shared\Http\ApiException;
use PHPUnit\Framework\Attributes\Group;
use PHPUnit\Framework\TestCase;

/** PHASE-8-5 §5.2 renderer: prefix, footer bn/en, merge fields + fallbacks, unknown fields, email escaping (S115, S123). */
#[Group('campaigns')]
#[Group('security')]
class CampaignRendererTest extends TestCase
{
    private function brand(string $name = 'Jamdani House'): StoreBrand
    {
        return new StoreBrand('store-1', $name, 'jamdani.example.com', 'https://cdn.example.com/logo.png', '+8801700000001', 'shop@jamdani.example.com');
    }

    private function spec(string $body, string $language = 'en', string $channel = 'sms', ?string $subject = null): MessageSpec
    {
        return new MessageSpec($channel, $language, $body, $subject, 'EID20', 'Silk Saree', 'silk-saree');
    }

    public function test_sms_prefix_merge_fields_and_footer_en(): void
    {
        $sms = CampaignRenderer::sms($this->spec('Hi {name}, use {coupon} at {shop_link}. {product}'), $this->brand(), 'Karim Uddin', 'AbCdEfGh12');
        $this->assertSame("Jamdani House: Hi Karim, use EID20 at jamdani.example.com. Silk Saree jamdani.example.com/products/silk-saree\nSTOP: jamdani.example.com/u/AbCdEfGh12", $sms['text']);
        $this->assertSame('gsm7', $sms['encoding']);
        $this->assertSame(1, $sms['parts']);
    }

    public function test_sms_footer_bn_fallback_name_and_shop_truncation(): void
    {
        $sms = CampaignRenderer::sms($this->spec('{name}, ঈদ মোবারক!', 'bn'), $this->brand('A very long shop name that goes on'), null, 'AbCdEfGh12');
        $this->assertStringStartsWith('A very long shop nam: গ্রাহক, ঈদ মোবারক!', $sms['text']);
        $this->assertStringEndsWith("\nবন্ধ করতে: jamdani.example.com/u/AbCdEfGh12", $sms['text']);
        $this->assertSame('ucs2', $sms['encoding']);
        $en = CampaignRenderer::sms($this->spec('Hi {name}'), $this->brand(), '  ', 'AbCdEfGh12');
        $this->assertStringContainsString('Hi there', $en['text']);
        // The name is one line, ≤ 20 chars, no links.
        $long = CampaignRenderer::sms($this->spec('Hi {name}'), $this->brand(), "Abcdefghijklmnopqrstuvwxyz\nX", 'AbCdEfGh12');
        $this->assertStringContainsString('Hi Abcdefghijklmnopqrst', $long['text']);
    }

    public function test_unknown_merge_fields_are_rejected(): void
    {
        $this->assertSame(['{first_name}', '{x}'], CampaignRenderer::unknownFields('Hi {first_name} {name} {x} {coupon}'));
        $this->assertSame([], CampaignRenderer::unknownFields('Use {coupon} at {shop_link} — 50% off {product} for {name}'));
        try {
            CampaignRenderer::assertKnownFields('Hello {email}');
            $this->fail('expected 422');
        } catch (ApiException $e) {
            $this->assertSame(422, $e->getStatusCode());
            $this->assertSame('campaign_unknown_merge_field', $e->errorCode);
            $this->assertSame(['fields' => ['{email}']], $e->details);
        }
    }

    public function test_email_escapes_everything_and_links_only_http_urls(): void
    {
        $body = "Hi {name}!\n<script>alert(1)</script> <b>bold</b>\n\nSee https://example.com/sale?a=1&b=2. Or javascript:alert(2) and <a href=\"javascript:x\">x</a>\nShop: {shop_link}";
        $mail = CampaignRenderer::email($this->spec($body, 'en', 'email', 'Eid <sale> for {name}'), $this->brand(), 'Nusrat <img src=x>', 'AbCdEfGh12');

        $this->assertSame('Eid <sale> for Nusrat', $mail['subject']);
        $this->assertStringNotContainsString('<script>', $mail['html']);
        $this->assertStringNotContainsString('<b>', $mail['html']);
        $this->assertStringNotContainsString('<img src=x', $mail['html']);
        $this->assertStringContainsString('&lt;script&gt;alert(1)&lt;/script&gt;', $mail['html']);
        $this->assertStringContainsString('<a href="https://example.com/sale?a=1&amp;b=2" style="color:#5b53ff">https://example.com/sale?a=1&amp;b=2</a>.', $mail['html']);
        $this->assertStringNotContainsString('href="javascript', $mail['html']);
        $this->assertSame(1, substr_count($mail['html'], '<a href="https://jamdani.example.com"'));
        $this->assertSame(2, substr_count($mail['html'], '<p '), 'paragraphs from blank lines');
        $this->assertStringContainsString('<a href="https://jamdani.example.com/u/AbCdEfGh12"', $mail['html']);
        $this->assertSame('https://jamdani.example.com/u/AbCdEfGh12', $mail['unsubscribe_url']);
        $this->assertSame('https://jamdani.example.com/u/AbCdEfGh12/one-click', $mail['one_click_url']);
        $this->assertStringContainsString('Unsubscribe: https://jamdani.example.com/u/AbCdEfGh12', $mail['text']);
        $this->assertStringContainsString('Jamdani House · +8801700000001 · shop@jamdani.example.com', $mail['text']);
    }
}
