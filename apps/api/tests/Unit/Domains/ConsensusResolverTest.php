<?php

declare(strict_types=1);

namespace Tests\Unit\Domains;

use App\Domain\Domains\Dns\ConsensusResolver;
use App\Domain\Domains\Dns\DnsAnswer;
use App\Domain\Domains\Dns\DnsCheckResult;
use App\Domain\Domains\Dns\FakeDnsResolver;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/** P6-2 / P6-3: per-record consensus of two resolvers (fakes with separate key prefixes). */
#[Group('domains')]
class ConsensusResolverTest extends TestCase
{
    private const T = 'customers.storeplix.test';

    private function resolver(): ConsensusResolver
    {
        return new ConsensusResolver([new FakeDnsResolver('cloudflare', 'cf'), new FakeDnsResolver('google', 'gg')]);
    }

    /** @param list<string>|string|null $values */
    private function both(string $name, string $type, array|string|null $values): void
    {
        FakeDnsResolver::set($name, $type, $values, 'cf');
        FakeDnsResolver::set($name, $type, $values, 'gg');
    }

    private function verify(): DnsCheckResult
    {
        return $this->resolver()->verify('shop.acme.com', '_v.shop.acme.com', 'sp-verify=tok', self::T);
    }

    public function test_agree_ok_and_agree_missing(): void
    {
        $this->assertSame(['missing', 'missing', 'fail'], [$this->verify()->ownership['status'], $this->verify()->routing['status'], $this->verify()->outcome]);
        $this->both('_v.shop.acme.com', 'TXT', ['other', 'sp-verify=tok']);
        $this->both('shop.acme.com', 'CNAME', [self::T]);
        $r = $this->verify();
        $this->assertSame(['ok', 'ok', 'ok', ['sp-verify=tok']], [$r->ownership['status'], $r->routing['status'], $r->outcome, $r->ownership['found']]);
    }

    public function test_disagreement_is_a_mismatch_and_an_error_is_inconclusive(): void
    {
        $this->both('shop.acme.com', 'CNAME', [self::T]);
        FakeDnsResolver::set('_v.shop.acme.com', 'TXT', ['sp-verify=tok'], 'cf');
        $r = $this->verify();
        $this->assertSame(['mismatch', 'fail', 'txt_mismatch'], [$r->ownership['status'], $r->outcome, $r->failureCode()?->value]);

        FakeDnsResolver::set('_v.shop.acme.com', 'TXT', FakeDnsResolver::SERVFAIL, 'gg');
        $r = $this->verify();
        $this->assertSame(['pending', 'inconclusive', ['cloudflare' => 'ok', 'google' => 'error']], [$r->ownership['status'], $r->outcome, $r->resolvers]);
    }

    public function test_txt_chunks_are_joined(): void
    {
        $this->assertSame('sp-verify=abcdef', DnsAnswer::txt('"sp-verify=abc" "def"'));
        $this->assertSame('a"b', DnsAnswer::txt('"a\\"b"'));
        $this->assertSame('plain', DnsAnswer::txt('plain'));
        $answer = DnsAnswer::ok([['type' => 5, 'data' => 'Customers.StorePlix.test.'], ['type' => 1, 'data' => '192.0.2.1']]);
        $this->assertSame([self::T], $answer->values('CNAME'));
        $this->assertSame(['192.0.2.1'], $answer->values('A'));
    }

    public function test_cname_chain_and_wrong_cname(): void
    {
        $this->both('_v.shop.acme.com', 'TXT', ['sp-verify=tok']);
        $this->both('shop.acme.com', 'CNAME', ['elsewhere.example.net']);
        $r = $this->verify();
        $this->assertSame(['mismatch', ['elsewhere.example.net'], 'cname_mismatch'], [$r->routing['status'], $r->routing['found'], $r->failureCode()?->value]);
    }

    public function test_flattened_apex_subset_rules(): void
    {
        $this->both('_v.shop.acme.com', 'TXT', ['sp-verify=tok']);
        $this->both(self::T, 'A', ['192.0.2.10', '192.0.2.11']);
        $this->both(self::T, 'AAAA', ['2001:db8::1']);

        $this->both('shop.acme.com', 'A', ['192.0.2.10']);
        $r = $this->verify();
        $this->assertSame(['ok', 'flattened'], [$r->routing['status'], $r->routing['mode']]);

        $this->both('shop.acme.com', 'AAAA', ['2001:db8::1']);
        $this->assertTrue($this->verify()->passed());

        $this->both('shop.acme.com', 'A', ['192.0.2.10', '203.0.113.9']); // superset → mismatch
        $r = $this->verify();
        $this->assertSame(['mismatch', 'flattened', 'cname_mismatch'], [$r->routing['status'], $r->routing['mode'], $r->failureCode()?->value]);

        $this->both('shop.acme.com', 'A', []);
        $this->both('shop.acme.com', 'AAAA', ['2001:db8::1']); // AAAA only → A set empty → mismatch
        $this->assertSame('mismatch', $this->verify()->routing['status']);
    }

    public function test_found_values_are_capped(): void
    {
        $this->both('_v.shop.acme.com', 'TXT', array_map(fn ($i) => 'v'.$i.str_repeat('x', 300), range(1, 8)));
        $r = $this->verify();
        $this->assertCount(5, $r->ownership['found']);
        $this->assertSame(255, mb_strlen($r->ownership['found'][0]));
    }
}
