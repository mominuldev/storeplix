<?php

declare(strict_types=1);

namespace App\Domain\Marketing\Content;

use App\Domain\Marketing\Models\Campaign;
use App\Domain\Orders\Notifications\SmsTemplates;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Sms\SmsSender;

/**
 * PHASE-8-5 §5.2 rendering — pure functions of (message, store, recipient name, unsubscribe code); unit tested.
 *
 * SMS (P85-6, P85-18): `"{shop}: " + body (merge fields) + "\n" + footer`; shop name ≤ 20 chars; footer bn
 * `বন্ধ করতে: {host}/u/{code}`, en `STOP: {host}/u/{code}`.
 * Email (P85-19): subject + plain text; the HTML is a fixed platform template — logo + store name, paragraphs from
 * blank lines, `https?://` URLs auto-linked, everything else escaped (S123), footer = store contact line +
 * unsubscribe link. Merge fields P85-20: {name} {coupon} {shop_link} {product}; anything else → 422.
 *
 * PHASE-8-6 §8: automation messages may also use {order_no} and {cart_link} (per-recipe lists, `assertAllowedFields`)
 * and are capped at 3 SMS parts (`assertMaxParts`, `max_parts` 3); campaigns keep their list and 5 parts.
 */
final class CampaignRenderer
{
    public const MERGE_FIELDS = ['{name}', '{coupon}', '{shop_link}', '{product}'];

    /** PHASE-8-6 §8: every merge field an automation message can use (each recipe allows a subset). */
    public const AUTOMATION_MERGE_FIELDS = ['{name}', '{coupon}', '{shop_link}', '{product}', '{cart_link}', '{order_no}'];

    /** Estimates: a 20-character sample name (§6.1) and a sample code. */
    public const SAMPLE_NAME = 'Abcdefghijklmnopqrst';

    public const SAMPLE_CODE = 'Xxxxxxxxxx';

    /**
     * @param  list<string>|null  $allowed  null = the campaign list (P85-20)
     * @return list<string> unknown `{…}` fields in the text, in order of appearance
     */
    public static function unknownFields(string $text, ?array $allowed = null): array
    {
        preg_match_all('/\{[^{}\s]{0,40}\}/u', $text, $m);

        return array_values(array_unique(array_diff($m[0], $allowed ?? self::MERGE_FIELDS)));
    }

    /** @throws ApiException 422 campaign_unknown_merge_field */
    public static function assertKnownFields(string ...$texts): void
    {
        self::assertAllowedFields(self::MERGE_FIELDS, ...$texts);
    }

    /**
     * @param  list<string>  $allowed
     *
     * @throws ApiException 422 campaign_unknown_merge_field
     */
    public static function assertAllowedFields(array $allowed, string ...$texts): void
    {
        $unknown = [];
        foreach ($texts as $text) {
            $unknown = [...$unknown, ...self::unknownFields($text, $allowed)];
        }
        $unknown = array_values(array_unique($unknown));
        if ($unknown !== []) {
            $use = $allowed === [] ? 'This message has no merge fields.' : 'Use '.self::humanList($allowed).'.';

            throw new ApiException(422, 'campaign_unknown_merge_field', 'Unknown merge field: '.implode(', ', $unknown).'. '.$use, ['fields' => $unknown]);
        }
    }

    /**
     * PHASE-8-6 §8 `max_parts`: the SMS rendered with `$code` (and the spec's sample values) must fit `$maxParts` parts.
     *
     * @throws ApiException 422 campaign_too_long
     */
    public static function assertMaxParts(MessageSpec $spec, StoreBrand $store, int $maxParts, ?string $customerName = self::SAMPLE_NAME, string $code = self::SAMPLE_CODE): int
    {
        $parts = self::sms($spec, $store, $customerName, $code)['parts'];
        if ($parts > $maxParts) {
            throw new ApiException(422, 'campaign_too_long', "This SMS is {$parts} parts long; the maximum is {$maxParts} (the shop name and the opt-out link count too).", ['parts' => $parts, 'max_parts' => $maxParts]);
        }

        return $parts;
    }

    /** @param list<string> $items */
    private static function humanList(array $items): string
    {
        if (count($items) <= 1) {
            return implode('', $items);
        }

        return implode(', ', array_slice($items, 0, -1)).' or '.end($items);
    }

    public static function usesField(MessageSpec $spec, string $field): bool
    {
        return str_contains($spec->body, $field) || str_contains((string) $spec->subject, $field);
    }

    /** @return array{text: string, parts: int, encoding: string, units: int} */
    public static function sms(MessageSpec $spec, StoreBrand $store, ?string $customerName, string $code): array
    {
        $shop = SmsTemplates::clean($store->name, 20);
        $body = self::merge($spec->body, $spec, $store, $customerName, false);
        $footer = ($spec->language === 'en' ? 'STOP: ' : 'বন্ধ করতে: ').$store->host.'/u/'.$code;
        // PHASE-8-9A P89A-17 (amends Q145): with the shop's approved masked sender ID the "{shop}: " prefix is dropped.
        $prefix = SmsSender::for($store->storeId) === null ? $shop.': ' : '';
        $text = $prefix.trim($body)."\n".$footer;
        $count = SmsParts::count($text);

        return ['text' => $text, 'parts' => $count['parts'], 'encoding' => $count['encoding'], 'units' => $count['units']];
    }

    /** @return array{subject: string, html: string, text: string, unsubscribe_url: string, one_click_url: string} */
    public static function email(MessageSpec $spec, StoreBrand $store, ?string $customerName, string $code): array
    {
        $unsubscribe = 'https://'.$store->host.'/u/'.$code;
        $subject = self::oneLine(self::merge((string) $spec->subject, $spec, $store, $customerName, true));
        $body = trim(str_replace(["\r\n", "\r"], "\n", self::merge($spec->body, $spec, $store, $customerName, true)));
        $contact = implode(' · ', array_filter([$store->name, $store->contactPhone, $store->contactEmail]));
        $bn = $spec->language === 'bn';
        $unsubscribeLabel = $bn ? 'আনসাবস্ক্রাইব করুন' : 'Unsubscribe';
        $why = $bn ? "আপনি {$store->name} থেকে কেনাকাটা করেছেন বলে এই ইমেইল পাচ্ছেন।" : "You get this email because you shopped at {$store->name}.";

        $paragraphs = '';
        foreach (preg_split('/\n[ \t]*\n+/', $body) ?: [] as $paragraph) {
            if (trim($paragraph) === '') {
                continue;
            }
            $lines = array_map(fn (string $line) => self::linkify($line), explode("\n", trim($paragraph)));
            $paragraphs .= '<p style="margin:0 0 16px;line-height:1.6">'.implode('<br>', $lines)."</p>\n";
        }
        $logo = $store->logoUrl !== null && preg_match('~^https?://~i', $store->logoUrl) === 1
            ? '<img src="'.self::e($store->logoUrl).'" alt="" height="40" style="display:block;margin:0 auto 8px;max-height:40px">'
            : '';
        $lang = $bn ? 'bn' : 'en';
        $eSubject = self::e($subject);
        $eName = self::e($store->name);
        $eContact = self::e($contact);
        $eWhy = self::e($why);
        $eUnsubscribe = self::e($unsubscribe);
        $eLabel = self::e($unsubscribeLabel);
        $html = <<<HTML
<!doctype html>
<html lang="{$lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>{$eSubject}</title></head>
<body style="margin:0;padding:0;background:#f5f5f7;font-family:Arial,Helvetica,sans-serif;color:#1d1d1f">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f7"><tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:8px">
<tr><td style="padding:24px 24px 8px;text-align:center">{$logo}<div style="font-size:18px;font-weight:bold">{$eName}</div></td></tr>
<tr><td style="padding:16px 24px 8px;font-size:15px">
{$paragraphs}</td></tr>
<tr><td style="padding:16px 24px 24px;border-top:1px solid #e5e5ea;font-size:12px;color:#6e6e73;line-height:1.5">
{$eContact}<br>{$eWhy}<br><a href="{$eUnsubscribe}" style="color:#6e6e73">{$eLabel}</a>
</td></tr>
</table></td></tr></table>
</body></html>
HTML;

        $text = $body."\n\n--\n".$contact."\n".$why."\n".$unsubscribeLabel.': '.$unsubscribe."\n";

        return ['subject' => $subject, 'html' => $html, 'text' => $text, 'unsubscribe_url' => $unsubscribe, 'one_click_url' => $unsubscribe.'/one-click'];
    }

    /** Merge fields (P85-20). */
    public static function merge(string $text, MessageSpec $spec, StoreBrand $store, ?string $customerName, bool $email): string
    {
        $first = SmsTemplates::clean(explode(' ', trim((string) $customerName))[0] ?? '', 20);
        if ($first === '') {
            $first = $spec->language === 'en' ? 'there' : 'গ্রাহক';
        }
        $link = ($email ? 'https://' : '').$store->host;
        $product = match (true) {
            $spec->productName === null => '',
            // PHASE-8-6 §8: an automation may render the product name without its link (3-part SMS fallback).
            $spec->productSlug === null => SmsTemplates::clean($spec->productName, $spec->productNameMax),
            default => SmsTemplates::clean($spec->productName, $spec->productNameMax).' '.$link.'/products/'.$spec->productSlug,
        };

        return strtr($text, [
            '{name}' => $first,
            '{coupon}' => (string) $spec->couponCode,
            '{shop_link}' => $link,
            '{product}' => $product,
            // PHASE-8-6 §8 (automation messages only; campaigns reject these fields before rendering).
            '{order_no}' => SmsTemplates::clean((string) $spec->orderNo, 24),
            '{cart_link}' => (string) $spec->cartLink,
        ]);
    }

    public static function isEmail(MessageSpec $spec): bool
    {
        return $spec->channel === Campaign::EMAIL;
    }

    private static function oneLine(string $value): string
    {
        return trim((string) preg_replace('/\s+/u', ' ', (string) preg_replace('/[\x00-\x1F\x7F]/u', ' ', $value)));
    }

    /** Escapes a line and turns http(s) URLs into links; nothing else becomes markup (S123). */
    private static function linkify(string $line): string
    {
        $out = '';
        $offset = 0;
        if (preg_match_all('~https?://[^\s<>"\']+~iu', $line, $m, PREG_OFFSET_CAPTURE) > 0) {
            foreach ($m[0] as [$url, $pos]) {
                $trimmed = rtrim($url, '.,;:!?)\']}');
                $out .= self::e(substr($line, $offset, $pos - $offset));
                $out .= '<a href="'.self::e($trimmed).'" style="color:#5b53ff">'.self::e($trimmed).'</a>';
                $offset = $pos + strlen($trimmed);
            }
        }

        return $out.self::e(substr($line, $offset));
    }

    private static function e(string $value): string
    {
        return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE | ENT_HTML5, 'UTF-8');
    }
}
