<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Support;

/**
 * Inbound addresses on the platform mail domain (PHASE-8-8E P88E-15, §11.1, S243):
 *  - store `shop-{key}@domain` (key = 12 lowercase base32, rotatable);
 *  - conversation `c-{ulid}-{sig}@domain` and order `o-{ulid}-{sig}@domain`, sig = first 12 hex of
 *    HMAC-SHA256(INBOX_REPLY_SECRET, "{kind}:{ulid}"). A guessed `c-…` without the right sig is ignored.
 */
final class ReplyAddress
{
    public const STORE = 'store';

    public const CONVERSATION = 'conversation';

    public const ORDER = 'order';

    public static function domain(): string
    {
        return strtolower((string) config('inbox.mail_domain'));
    }

    public static function store(string $key): ?string
    {
        return self::domain() === '' ? null : 'shop-'.strtolower($key).'@'.self::domain();
    }

    public static function conversation(string $id): ?string
    {
        return self::domain() === '' ? null : 'c-'.strtolower($id).'-'.self::sig('c', $id).'@'.self::domain();
    }

    public static function order(string $id): ?string
    {
        return self::domain() === '' ? null : 'o-'.strtolower($id).'-'.self::sig('o', $id).'@'.self::domain();
    }

    public static function sig(string $kind, string $id, ?string $secret = null): string
    {
        return substr(hash_hmac('sha256', $kind.':'.strtolower($id), $secret ?? InboxSecrets::reply()), 0, 12);
    }

    /**
     * The first recipient on the mail domain decides the target. Unknown shapes and bad signatures → null.
     *
     * @param  list<string>  $recipients
     * @return array{kind: string, key: string}|null
     */
    public static function target(array $recipients, ?string $domain = null, ?string $secret = null): ?array
    {
        $domain = strtolower($domain ?? self::domain());
        if ($domain === '') {
            return null;
        }
        foreach ($recipients as $recipient) {
            $address = self::bare($recipient);
            if ($address === null || ! str_ends_with($address, '@'.$domain)) {
                continue;
            }
            $local = substr($address, 0, -strlen('@'.$domain));
            $local = explode('+', $local)[0];
            if (preg_match('/^shop-([a-z2-7]{12})$/', $local, $m) === 1) {
                return ['kind' => self::STORE, 'key' => $m[1]];
            }
            if (preg_match('/^([co])-([0-9a-hjkmnp-tv-z]{26})-([0-9a-f]{12})$/', $local, $m) === 1) {
                if (! hash_equals(self::sig($m[1], $m[2], $secret), $m[3])) {
                    return null;
                }

                return ['kind' => $m[1] === 'c' ? self::CONVERSATION : self::ORDER, 'key' => $m[2]];
            }

            return null; // the first address on our domain decides
        }

        return null;
    }

    /** `"Name" <a@b>` / `a@b` → lowercase `a@b`; null when not an address. */
    public static function bare(string $value): ?string
    {
        $value = trim($value);
        if (preg_match('/<([^<>\s]+@[^<>\s]+)>/', $value, $m) === 1) {
            $value = $m[1];
        }
        $value = strtolower(trim($value, " \t\"'"));

        return filter_var($value, FILTER_VALIDATE_EMAIL) !== false ? $value : null;
    }

    /** @return list<string> every address in a To / Cc header value */
    public static function split(?string $header): array
    {
        if ($header === null || trim($header) === '') {
            return [];
        }
        $out = [];
        foreach (preg_split('/,(?=(?:[^"]*"[^"]*")*[^"]*$)/', $header) ?: [] as $part) {
            if (($bare = self::bare($part)) !== null) {
                $out[] = $bare;
            }
        }

        return $out;
    }
}
