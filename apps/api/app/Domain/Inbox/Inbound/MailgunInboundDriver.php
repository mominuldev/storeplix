<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Inbound;

use App\Domain\Inbox\Support\ReplyAddress;
use Illuminate\Http\Request;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Cache;

/**
 * Mailgun "forward" routes (parsed POST, multipart): HMAC-SHA256(signing key, timestamp . token) = signature, the
 * timestamp within ±15 minutes and the token unseen in the platform cache for 1 hour (S243). Fields: recipient, sender,
 * from, subject, body-plain, body-html, Message-Id, In-Reply-To, To, Cc, message-headers (JSON pairs),
 * X-Mailgun-Spf / X-Mailgun-Dkim-Check-Result, X-Mailgun-Sflag, attachment-1..n.
 */
class MailgunInboundDriver implements InboundMailDriver
{
    public const SKEW_SECONDS = 900;

    protected function signingKey(): string
    {
        return (string) config('inbox.mailgun.signing_key', '');
    }

    protected function name(): string
    {
        return 'mailgun';
    }

    public function verify(Request $request): bool
    {
        $key = $this->signingKey();
        $timestamp = (string) $request->input('timestamp', $request->input('signature.timestamp', ''));
        $token = (string) $request->input('token', $request->input('signature.token', ''));
        $signature = (string) $request->input('signature.signature', is_string($request->input('signature')) ? $request->input('signature') : '');
        if ($key === '' || ! ctype_digit($timestamp) || strlen($token) < 20 || strlen($token) > 128 || $signature === '') {
            return false;
        }
        if (abs(now()->getTimestamp() - (int) $timestamp) > self::SKEW_SECONDS) {
            return false;
        }
        if (! hash_equals(hash_hmac('sha256', $timestamp.$token, $key), strtolower($signature))) {
            return false;
        }

        // Replay: a platform (not tenant) cache key; add() is atomic.
        return Cache::add('inbound-email-token:'.$this->name().':'.hash('sha256', $token), 1, 3600);
    }

    public function parse(Request $request): InboundEmail
    {
        $headers = $this->headers($request);
        $header = fn (string $name) => $headers[strtolower($name)] ?? null;
        $str = fn (string $key) => is_string($request->input($key)) ? (string) $request->input($key) : null;

        $recipients = [];
        foreach (array_merge([$str('recipient') ?? ''], explode(',', $str('recipient') ?? '')) as $r) {
            if (($bare = ReplyAddress::bare($r)) !== null) {
                $recipients[] = $bare;
            }
        }
        $recipients = array_values(array_unique(array_merge($recipients, ReplyAddress::split($str('To') ?? $header('to')), ReplyAddress::split($str('Cc') ?? $header('cc')))));

        $fromHeader = $str('from') ?? $header('from') ?? $str('sender') ?? '';
        $from = ReplyAddress::bare($fromHeader) ?? ReplyAddress::bare($str('sender') ?? '') ?? '';
        $fromName = preg_match('/^\s*"?([^"<]+?)"?\s*</', $fromHeader, $m) === 1 ? trim($m[1]) : null;

        $spf = strtolower((string) ($str('X-Mailgun-Spf') ?? $header('x-mailgun-spf') ?? ''));
        $dkim = strtolower((string) ($str('X-Mailgun-Dkim-Check-Result') ?? $header('x-mailgun-dkim-check-result') ?? ''));
        $auto = strtolower((string) ($header('auto-submitted') ?? 'no'));
        $precedence = strtolower((string) ($header('precedence') ?? ''));
        $spam = strtolower((string) ($str('X-Mailgun-Sflag') ?? $header('x-mailgun-sflag') ?? 'no')) === 'yes';
        $daemon = preg_match('/^(mailer-daemon|postmaster|no-?reply|bounces?)([+@])/i', $from) === 1;

        $files = [];
        $count = min(20, (int) $request->input('attachment-count', 0));
        for ($i = 1; $i <= max($count, 10); $i++) {
            $file = $request->file('attachment-'.$i);
            if ($file instanceof UploadedFile) {
                $files[] = $file;
            }
        }

        return new InboundEmail(
            recipients: $recipients,
            from: $from,
            fromName: $fromName,
            subject: (string) ($str('subject') ?? $header('subject') ?? ''),
            text: (string) ($str('body-plain') ?? ''),
            html: $str('body-html'),
            messageId: self::messageId($str('Message-Id') ?? $header('message-id')),
            inReplyTo: self::messageId($str('In-Reply-To') ?? $header('in-reply-to')),
            authenticated: $spf === 'pass' || $dkim === 'pass',
            auto: ($auto !== '' && $auto !== 'no') || in_array($precedence, ['bulk', 'junk', 'list'], true) || $spam || $daemon || $from === '',
            attachments: $files,
        );
    }

    /** @return array<string, string> lowercase header name → value (message-headers JSON pairs) */
    private function headers(Request $request): array
    {
        $raw = $request->input('message-headers');
        $pairs = is_string($raw) ? json_decode($raw, true) : (is_array($raw) ? $raw : null);
        $out = [];
        foreach (is_array($pairs) ? $pairs : [] as $pair) {
            if (is_array($pair) && isset($pair[0], $pair[1]) && is_string($pair[0]) && is_string($pair[1])) {
                $out[strtolower($pair[0])] ??= $pair[1];
            }
        }

        return $out;
    }

    private static function messageId(?string $value): ?string
    {
        $value = trim((string) $value);
        if ($value === '') {
            return null;
        }
        if (preg_match('/<[^<>\s]+>/', $value, $m) === 1) {
            $value = $m[0];
        }

        return mb_substr($value, 0, 255);
    }
}
