<?php

declare(strict_types=1);

namespace Tests\Unit\Inbox;

use App\Domain\Inbox\Support\InboxText;
use App\Domain\Inbox\Support\OrderAccessToken;
use App\Domain\Inbox\Support\ReplyAddress;
use App\Domain\Inbox\Support\ThreadKey;
use App\Domain\Sms\SmsPreview;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/** PHASE-8-8E: reply-address HMAC, inbound target / thread matching, email trimming, order tokens, previews. */
#[Group('inbox')]
#[Group('security')]
class InboxAddressingTest extends TestCase
{
    private const ID = '01jd2x8q6v3f4g5h6j7k8m9n0p';

    protected function setUp(): void
    {
        parent::setUp();
        config(['inbox.mail_domain' => 'in.storeplix.test', 'inbox.reply_secret' => 'unit-secret']);
    }

    public function test_reply_addresses_are_signed_and_bound_to_kind_and_id(): void
    {
        $c = ReplyAddress::conversation(self::ID);
        $this->assertMatchesRegularExpression('/^c-'.self::ID.'-[0-9a-f]{12}@in\.storeplix\.test$/', (string) $c);
        $this->assertSame(['kind' => 'conversation', 'key' => self::ID], ReplyAddress::target(['"Shop" <'.$c.'>']));
        $this->assertSame(['kind' => 'order', 'key' => self::ID], ReplyAddress::target([(string) ReplyAddress::order(self::ID)]));
        // The c- signature never validates an o- address of the same id (kind-bound), nor another secret.
        $forged = str_replace('c-', 'o-', (string) $c);
        $this->assertNull(ReplyAddress::target([$forged]));
        $this->assertNull(ReplyAddress::target([$c], null, 'other-secret'));
        $this->assertNull(ReplyAddress::target(['c-'.self::ID.'-000000000000@in.storeplix.test']));
        $this->assertNotSame(ReplyAddress::sig('c', self::ID), ReplyAddress::sig('c', '01jd2x8q6v3f4g5h6j7k8m9n0q'));
    }

    public function test_inbound_target_matching(): void
    {
        $this->assertSame(['kind' => 'store', 'key' => 'abcdefgh2345'], ReplyAddress::target(['me@gmail.com', 'SHOP-abcdefgh2345@IN.storeplix.test']));
        $this->assertSame(['kind' => 'store', 'key' => 'abcdefgh2345'], ReplyAddress::target(['shop-abcdefgh2345+tag@in.storeplix.test']));
        $this->assertNull(ReplyAddress::target(['shop-abc@in.storeplix.test', 'shop-abcdefgh2345@in.storeplix.test'])); // first on our domain decides
        $this->assertNull(ReplyAddress::target(['x@other.test']));
        $this->assertNull(ReplyAddress::target(['shop-abcdefgh2345@in.storeplix.test'], ''));
        $this->assertSame(['a@x.test', 'b@y.test'], ReplyAddress::split('"Doe, A" <a@x.test>, b@y.test, junk'));
        $this->assertSame('email:nusrat@example.test', ThreadKey::email(' Nusrat@Example.test '));
        $this->assertSame('phone:8801711000222', ThreadKey::phone('8801711000222'));
        $this->assertSame('order:'.self::ID, ThreadKey::order(strtoupper(self::ID)));
    }

    public function test_email_text_trimming_and_html(): void
    {
        $this->assertSame('Thanks!', InboxText::trimEmail("Thanks!\n\nOn Tue, 3 Dec 2026, Shop <x@y> wrote:\n> Your order\n> shipped"));
        $this->assertSame("Yes\nplease", InboxText::trimEmail("Yes\n> quoted\nplease\n-- \nSig"));
        $this->assertSame('Hi', InboxText::trimEmail("Hi\n-----Original Message-----\nFrom: a"));
        $this->assertSame(10, mb_strlen(InboxText::trimEmail(str_repeat('a', 50), 10)));
        $this->assertSame("Hello\nworld & co", InboxText::htmlToText('<p>Hello</p><script>alert(1)</script><div>world &amp; co</div>'));
        $this->assertSame('ab', InboxText::clean("a\x00\x07b"));
        $this->assertSame('017••••5678', InboxText::maskPhone('8801711005678'));
    }

    public function test_order_tokens_are_store_bound_and_expire(): void
    {
        $t = OrderAccessToken::issue('tenant-a', 'store-a', self::ID, 60);
        $this->assertSame(self::ID, OrderAccessToken::verify($t, 'tenant-a', 'store-a'));
        $this->assertNull(OrderAccessToken::verify($t, 'tenant-a', 'store-b'));
        $this->assertNull(OrderAccessToken::verify($t, 'tenant-b', 'store-a'));
        $this->assertNull(OrderAccessToken::verify($t.'A', 'tenant-a', 'store-a'));
        $this->assertNull(OrderAccessToken::verify('garbage', 'tenant-a', 'store-a'));
        $this->assertSame(self::ID, OrderAccessToken::peekOrderId($t));
        $this->travel(2)->minutes();
        $this->assertNull(OrderAccessToken::verify($t, 'tenant-a', 'store-a'));
    }

    public function test_sms_previews_never_keep_codes_and_hide_links(): void
    {
        $this->assertNull(SmsPreview::of('inbox_verify', 'Shop: Your code is 123456.'));
        $this->assertSame('Shop: We replied to your message. Read it here: [link]', SmsPreview::of('inbox_reply', 'Shop: We replied to your message. Read it here: https://shop.test/m/abcdefghijklmnopqrstuv'));
    }
}
