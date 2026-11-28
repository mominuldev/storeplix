<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Inbound;

/**
 * Local / CI inbound mail (`INBOUND_MAIL_DRIVER=fake`, never in production): exactly the Mailgun field format and
 * signature scheme, signed with `INBOUND_MAIL_FAKE_KEY` (default `fake-inbound-signing-key`).
 */
final class FakeInboundDriver extends MailgunInboundDriver
{
    protected function signingKey(): string
    {
        return (string) config('inbox.fake.signing_key', '');
    }

    protected function name(): string
    {
        return 'fake';
    }
}
