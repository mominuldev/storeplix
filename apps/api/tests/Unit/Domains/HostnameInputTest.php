<?php

declare(strict_types=1);

namespace Tests\Unit\Domains;

use App\Domain\Domains\HostnameInput;
use App\Domain\Shared\Http\ApiException;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/** P6-4 / P6-5 / S43–S45: table-driven hostname normalisation. */
#[Group('domains')]
#[Group('security')]
class HostnameInputTest extends TestCase
{
    /** @return array<string, array{0: string, 1: string, 2?: string}> input → hostname, display */
    public static function valid(): array
    {
        return [
            'case + trailing dot' => ['  Shop.Acme.COM. ', 'shop.acme.com', 'shop.acme.com'],
            'apex' => ['acme.com', 'acme.com', 'acme.com'],
            'bd second level' => ['shop.com.bd', 'shop.com.bd', 'shop.com.bd'],
            'idn' => ['Bücher.example.com', 'xn--bcher-kva.example.com', 'bücher.example.com'],
            'punycode input' => ['xn--bcher-kva.example.com', 'xn--bcher-kva.example.com', 'bücher.example.com'],
            'cyrillic homograph' => ['ѕhop.com', 'xn--hop-ehd.com', 'ѕhop.com'],
            'private psl section' => ['me.github.io', 'me.github.io', 'me.github.io'],
            'deep subdomain' => ['a.b.c.acme.co.uk', 'a.b.c.acme.co.uk', 'a.b.c.acme.co.uk'],
        ];
    }

    #[DataProvider('valid')]
    public function test_valid(string $input, string $hostname, string $display): void
    {
        $host = HostnameInput::normalize($input);
        $this->assertSame([$hostname, $display], [$host->hostname, $host->display]);
    }

    public function test_registrable_and_apex(): void
    {
        $this->assertTrue(HostnameInput::normalize('acme.com.bd')->isApex());
        $this->assertFalse(HostnameInput::normalize('www.acme.com.bd')->isApex());
        $this->assertSame('acme.co.uk', HostnameInput::normalize('shop.acme.co.uk')->registrable);
    }

    /** @return array<string, array{0: string, 1: string}> input → error code */
    public static function invalid(): array
    {
        return [
            'scheme' => ['https://shop.acme.com', 'domain_invalid'],
            'path' => ['shop.acme.com/', 'domain_invalid'],
            'port' => ['shop.acme.com:443', 'domain_invalid'],
            'userinfo' => ['me@shop.acme.com', 'domain_invalid'],
            'wildcard' => ['*.acme.com', 'domain_invalid'],
            'whitespace' => ['shop acme.com', 'domain_invalid'],
            'query' => ['shop.acme.com?x', 'domain_invalid'],
            'single label' => ['shop', 'domain_invalid'],
            'ipv4' => ['127.0.0.1', 'domain_invalid'],
            'metadata ip' => ['169.254.169.254', 'domain_invalid'],
            'ipv6' => ['[::1]', 'domain_invalid'],
            'numeric tld' => ['shop.123', 'domain_invalid'],
            'localhost' => ['localhost', 'domain_invalid'],
            'internal' => ['metadata.google.internal', 'domain_invalid'],
            'onion' => ['abc.onion', 'domain_invalid'],
            'test tld' => ['shop.test', 'domain_invalid'],
            'public suffix' => ['com.bd', 'domain_invalid'],
            'public suffix co.uk' => ['co.uk', 'domain_invalid'],
            'private public suffix' => ['github.io', 'domain_invalid'],
            'unknown tld' => ['shop.notatld', 'domain_invalid'],
            'invalid punycode' => ['xn--a.com', 'domain_invalid'],
            'empty label' => ['shop..com', 'domain_invalid'],
            'leading hyphen' => ['-shop.acme.com', 'domain_invalid'],
            'underscore' => ['_x.acme.com', 'domain_invalid'],
            'too long' => [str_repeat('a', 60).'.'.str_repeat('b', 60).'.'.str_repeat('c', 60).'.'.str_repeat('d', 60).'.'.str_repeat('e', 60).'.com', 'domain_invalid'],
            'platform' => ['storeplix.test', 'domain_reserved'],
            'platform sub' => ['x.storeplix.test', 'domain_reserved'],
            'storeplix.com' => ['storeplix.com', 'domain_reserved'],
            'storeplix.com sub' => ['x.storeplix.com', 'domain_reserved'],
            'cname target' => ['customers.storeplix.test', 'domain_reserved'],
        ];
    }

    #[DataProvider('invalid')]
    public function test_invalid(string $input, string $code): void
    {
        try {
            HostnameInput::normalize($input);
            $this->fail("accepted {$input}");
        } catch (ApiException $e) {
            $this->assertSame([422, $code], [$e->getStatusCode(), $e->errorCode]);
            $this->assertArrayHasKey('hostname', (array) $e->details);
        }
    }

    public function test_configured_reserved_suffixes(): void
    {
        config(['domains.reserved_suffixes' => ['evil-brand.com']]);
        $this->expectExceptionMessage('belongs to Store Plix');
        HostnameInput::normalize('login.evil-brand.com');
    }

    public function test_localhost_only_with_the_fake_and_never_in_production(): void
    {
        config(['domains.fake' => true]);
        $this->assertSame('shop-1.localhost', HostnameInput::normalize('Shop-1.localhost')->hostname);
        config(['domains.fake' => false]);
        $this->assertCode('shop-1.localhost', 'domain_invalid');
        config(['domains.fake' => true]);
        $this->app['env'] = 'production';
        try {
            $this->assertCode('shop-1.localhost', 'domain_invalid');
        } finally {
            $this->app['env'] = 'testing';
        }
    }

    private function assertCode(string $input, string $code): void
    {
        try {
            HostnameInput::normalize($input);
            $this->fail("accepted {$input}");
        } catch (ApiException $e) {
            $this->assertSame($code, $e->errorCode);
        }
    }
}
