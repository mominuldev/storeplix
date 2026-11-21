<?php

namespace Tests\Unit;

use App\Domain\Themes\SafeHref;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Group;
use PHPUnit\Framework\TestCase;

#[Group('security')]
class SafeHrefTest extends TestCase
{
    /** @return array<string, array{0: string}> */
    public static function hostile(): array
    {
        return array_map(fn ($v) => [$v], [
            'javascript' => 'javascript:alert(1)',
            'mixed case' => 'JaVaScRiPt:alert(1)',
            'leading space' => ' javascript:alert(1)',
            'tab inside' => "java\tscript:alert(1)",
            'newline inside' => "java\nscript:alert(1)",
            'percent encoded' => '%6a%61vascript:alert(1)',
            'data' => 'data:text/html,<script>alert(1)</script>',
            'vbscript' => 'vbscript:msgbox(1)',
            'protocol relative' => '//evil.com',
            'backslash' => '/\\evil.com',
            'encoded slashes' => '/%2F%2Fevil.com',
            'encoded backslash' => '/%5Cevil.com',
            'double encoded' => '/%252F%252Fevil.com',
            'credentials' => 'https://user:pw@x.com',
            'user only' => 'https://user@x.com/',
            'encoded at' => 'https://evil.com%40good.com/',
            'no host' => 'https:///path',
            'relative no slash' => 'collections/kids',
            'control char' => "/a\x00b",
            'encoded control' => '/a%0d%0aSet-Cookie:x',
            'unicode space' => "/a\u{2028}b",
            'empty' => '',
            'too long' => '/'.str_repeat('a', 2048),
        ]);
    }

    #[DataProvider('hostile')]
    public function test_hostile_values_are_rejected_everywhere(string $value): void
    {
        $this->assertFalse(SafeHref::theme($value), 'theme');
        $this->assertFalse(SafeHref::navUrl($value), 'nav');
        $this->assertFalse(SafeHref::richText($value), 'rich text');
        $this->assertFalse(SafeHref::button($value), 'button');
    }

    public function test_allowed_values(): void
    {
        foreach (['/', '/collections/kids?sort=new#top', 'https://example.com', 'https://shop.example.com/a/b?c=d'] as $ok) {
            $this->assertTrue(SafeHref::theme($ok), $ok);
            $this->assertTrue(SafeHref::richText($ok), $ok);
            $this->assertTrue(SafeHref::button($ok), $ok);
        }
        $this->assertFalse(SafeHref::theme('http://example.com'));
        $this->assertTrue(SafeHref::navUrl('http://example.com'));
        $this->assertTrue(SafeHref::navUrl('HTTPS://Example.com/x'));
        $this->assertFalse(SafeHref::navUrl('/relative'));
        $this->assertFalse(SafeHref::navUrl('ftp://example.com'));

        $this->assertTrue(SafeHref::richText('http://example.com'));
        $this->assertTrue(SafeHref::richText('mailto:hello@shop.com'));
        $this->assertTrue(SafeHref::richText('tel:+8801712345678'));
        $this->assertFalse(SafeHref::richText('mailto:hello@shop.com?subject=x'));
        $this->assertFalse(SafeHref::richText('mailto:a@b.com%0abcc:c@d.com'));
        $this->assertFalse(SafeHref::richText('tel:123'));
        $this->assertFalse(SafeHref::theme('mailto:hello@shop.com'));

        $this->assertTrue(SafeHref::button('https://wa.me/8801712345678'));
        $this->assertTrue(SafeHref::button('tel:01712345678'));
        $this->assertFalse(SafeHref::button('mailto:hello@shop.com'));
    }
}
