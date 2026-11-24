<?php

declare(strict_types=1);

namespace Tests\Unit\Automations;

use App\Domain\Automations\Engine\RecoveryCodes;
use App\Domain\Automations\Messages\AutomationMessages;
use App\Domain\Automations\Recipes\RecipeCatalogue;
use App\Domain\Marketing\Content\CampaignRenderer;
use App\Domain\Marketing\Content\StoreBrand;
use App\Domain\Shared\Http\ApiException;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/** PHASE-8-6 §8 rendering: merge fields per recipe (C11), {order_no}/{cart_link}, the 3-part cap + product fallback, recovery codes. */
#[Group('automations')]
class AutomationMessagesTest extends TestCase
{
    private function brand(): StoreBrand
    {
        return new StoreBrand('s1', 'Gadget Shop', 'gadget.storeplix.test', null, '+8801700000001', 'shop@example.test');
    }

    public function test_merge_fields_and_rendering(): void
    {
        $message = ['channel' => 'sms', 'language' => 'en', 'body' => 'Hi {name}, {product} is waiting: {cart_link} ({order_no})', 'subject' => null];
        $r = AutomationMessages::render($message, $this->brand(), 'Rafi Ahmed', 'Abcdefghij', null, ['name' => 'Panjabi', 'slug' => 'panjabi'], 'GS-1048', 'https://gadget.storeplix.test/r/Xyz1234567');
        $this->assertSame("Gadget Shop: Hi Rafi, Panjabi gadget.storeplix.test/products/panjabi is waiting: https://gadget.storeplix.test/r/Xyz1234567 (GS-1048)\nSTOP: gadget.storeplix.test/u/Abcdefghij", $r['text']);
        $this->assertSame(2, $r['parts']);

        // Campaigns keep their list: the automation fields are unknown there.
        $this->assertSame(['{cart_link}', '{order_no}'], CampaignRenderer::unknownFields('{cart_link} {order_no} {name}'));
        $this->assertSame([], CampaignRenderer::unknownFields('{cart_link} {order_no}', CampaignRenderer::AUTOMATION_MERGE_FIELDS));
        try {
            AutomationMessages::assertValid(RecipeCatalogue::get('vip_tag'), $this->brand(), ['channel' => 'sms', 'language' => 'en', 'body' => '{cart_link}', 'subject' => null], null);
            $this->fail('expected 422');
        } catch (ApiException $e) {
            $this->assertSame(['campaign_unknown_merge_field', ['fields' => ['{cart_link}']]], [$e->errorCode, $e->details]);
        }
    }

    public function test_three_part_cap_and_product_fallback(): void
    {
        $long = str_repeat('x', 480);
        try {
            AutomationMessages::assertValid(RecipeCatalogue::get('thank_you'), $this->brand(), ['channel' => 'sms', 'language' => 'en', 'body' => $long, 'subject' => null], null);
            $this->fail('expected 422');
        } catch (ApiException $e) {
            $this->assertSame('campaign_too_long', $e->errorCode);
            $this->assertSame(3, $e->details['max_parts']);
        }
        // A real product whose name + link would overflow falls back to the name only / 20 characters.
        $message = ['channel' => 'sms', 'language' => 'en', 'body' => str_repeat('y', 330).' {product}', 'subject' => null];
        $r = AutomationMessages::render($message, $this->brand(), 'Rafi', 'Abcdefghij', null, ['name' => str_repeat('P', 60), 'slug' => str_repeat('p', 200)], null, null);
        $this->assertLessThanOrEqual(3, $r['parts']);
        $this->assertStringNotContainsString('/products/', $r['text']);
    }

    public function test_recovery_codes_are_stable_base62_and_hashed(): void
    {
        $a = RecoveryCodes::for('01JD0000000000000000000000');
        $this->assertMatchesRegularExpression('/^[A-Za-z0-9]{10}$/', $a);
        $this->assertSame($a, RecoveryCodes::for('01JD0000000000000000000000'));
        $this->assertNotSame($a, RecoveryCodes::for('01JD0000000000000000000001'));
        $this->assertSame(hash('sha256', $a), RecoveryCodes::hash($a));
    }
}
