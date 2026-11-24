<?php

declare(strict_types=1);

namespace App\Domain\Automations\Messages;

use App\Domain\Automations\Recipes\Recipe;
use App\Domain\Coupons\Models\Coupon;
use App\Domain\Marketing\Content\CampaignRenderer;
use App\Domain\Marketing\Content\MessageSpec;
use App\Domain\Marketing\Content\StoreBrand;

/**
 * Automation messages through the 8.5 renderer (PHASE-8-6 §8, P86-7): the recipe's merge fields only, ≤ 3 SMS parts
 * including the shop prefix and the opt-out footer (checked with sample values at save), email ≤ 3,000 characters with
 * the fixed template. At send time an SMS whose real values would exceed the cap renders `{product}` as the name only,
 * then as a 20-character name — never longer than the validated sample.
 */
final class AutomationMessages
{
    public const SAMPLE_PRODUCT = 'Abcdefghijklmnopqrst';

    public const SAMPLE_SLUG = 'abcdefghijklmnopqrst';

    public const SAMPLE_ORDER_NO = 'XXXXX-999999';

    public const SAMPLE_COUPON = 'SAMPLECODE12';

    public static function maxParts(): int
    {
        return (int) config('automations.sms_max_parts', 3);
    }

    public static function cartLink(StoreBrand $brand, string $code): string
    {
        return 'https://'.$brand->host.'/r/'.$code;
    }

    /**
     * @param  array<string, mixed>  $message  {channel, language, body, subject}
     * @param  array{name: string, slug: string|null}|null  $product
     */
    public static function spec(array $message, ?string $couponCode, ?array $product, ?string $orderNo, ?string $cartLink): MessageSpec
    {
        return new MessageSpec(
            (string) $message['channel'],
            (string) $message['language'],
            (string) $message['body'],
            ($message['channel'] ?? 'sms') === 'email' ? (string) ($message['subject'] ?? '') : null,
            $couponCode,
            $product['name'] ?? null,
            $product['slug'] ?? null,
            $orderNo,
            $cartLink,
        );
    }

    /**
     * Save-time checks: merge fields of the recipe (422 campaign_unknown_merge_field) and ≤ 3 SMS parts with the
     * sample render (422 campaign_too_long).
     *
     * @param  array<string, mixed>  $message
     */
    public static function assertValid(Recipe $recipe, StoreBrand $brand, array $message, ?Coupon $coupon): void
    {
        CampaignRenderer::assertAllowedFields($recipe->mergeFields(), (string) $message['body'], (string) ($message['subject'] ?? ''));
        if ($message['channel'] === 'sms') {
            CampaignRenderer::assertMaxParts(self::sample($message, $brand, $coupon), $brand, self::maxParts());
        }
    }

    /** The sample spec (20-char name/product, longest codes) used for limits and estimates. @param array<string, mixed> $message */
    public static function sample(array $message, StoreBrand $brand, ?Coupon $coupon): MessageSpec
    {
        return self::spec(
            $message,
            $coupon?->code ?? self::SAMPLE_COUPON,
            ['name' => self::SAMPLE_PRODUCT, 'slug' => self::SAMPLE_SLUG],
            self::SAMPLE_ORDER_NO,
            self::cartLink($brand, CampaignRenderer::SAMPLE_CODE),
        );
    }

    /**
     * Renders one message for a recipient.
     *
     * @param  array<string, mixed>  $message
     * @param  array{name: string, slug: string|null}|null  $product
     * @return array{channel: string, subject: string|null, text: string, parts: int, email: array{subject: string, html: string, text: string, unsubscribe_url: string, one_click_url: string}|null, unsubscribe_url: string}
     */
    public static function render(array $message, StoreBrand $brand, ?string $name, string $code, ?string $couponCode, ?array $product, ?string $orderNo, ?string $cartLink): array
    {
        $spec = self::spec($message, $couponCode, $product, $orderNo, $cartLink);
        if ($spec->channel === 'email') {
            $email = CampaignRenderer::email($spec, $brand, $name, $code);

            return ['channel' => 'email', 'subject' => $email['subject'], 'text' => $email['text'], 'parts' => 1, 'email' => $email, 'unsubscribe_url' => $email['unsubscribe_url']];
        }
        $max = self::maxParts();
        $sms = CampaignRenderer::sms($spec, $brand, $name, $code);
        foreach ([fn () => $spec->withoutProductLink(), fn () => $spec->withoutProductLink(20)] as $fallback) {
            if ($sms['parts'] <= $max || $spec->productName === null) {
                break;
            }
            $sms = CampaignRenderer::sms($fallback(), $brand, $name, $code);
        }

        return ['channel' => 'sms', 'subject' => null, 'text' => $sms['text'], 'parts' => $sms['parts'], 'email' => null, 'unsubscribe_url' => 'https://'.$brand->host.'/u/'.$code];
    }
}
