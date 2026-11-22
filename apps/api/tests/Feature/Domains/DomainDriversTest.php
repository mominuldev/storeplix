<?php

declare(strict_types=1);

namespace Tests\Feature\Domains;

use App\Domain\Domains\Dns\ConsensusResolver;
use App\Domain\Domains\Dns\DohResolver;
use App\Domain\Domains\Providers\CloudflareCustomHostnames;
use App\Domain\Domains\Providers\ProviderException;
use Illuminate\Http\Client\ConnectionException;
use Illuminate\Http\Client\Factory;
use Illuminate\Http\Client\Request;
use Illuminate\Support\Facades\Http;
use Illuminate\Support\Facades\Log;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/** §10 Drivers: DohResolver / ConsensusResolver and CloudflareCustomHostnames against Http::fake fixtures. */
#[Group('domains')]
class DomainDriversTest extends TestCase
{
    private const TOKEN = 'cf-secret-token-never-logged';

    private function fixture(string $path): array
    {
        return json_decode((string) file_get_contents(base_path('tests/Fixtures/domains/'.$path.'.json')), true, flags: JSON_THROW_ON_ERROR);
    }

    private function consensus(): ConsensusResolver
    {
        return new ConsensusResolver([
            new DohResolver('cloudflare', 'https://cloudflare-dns.com/dns-query'),
            new DohResolver('google', 'https://dns.google/resolve'),
        ]);
    }

    /** @param array<string, array<string, string|int>> $answers "host|TYPE" → fixture name or HTTP status, per resolver host */
    private function fakeDoh(array $cloudflare, ?array $google = null): void
    {
        $google ??= $cloudflare;
        $this->freshHttp();
        Http::fake(function (Request $request) use ($cloudflare, $google) {
            parse_str((string) parse_url($request->url(), PHP_URL_QUERY), $q);
            $host = (string) parse_url($request->url(), PHP_URL_HOST);
            $map = $host === 'dns.google' ? $google : $cloudflare;
            $answer = $map[$q['name'].'|'.$q['type']] ?? 'nxdomain';
            if (is_int($answer)) {
                return Http::response('', $answer);
            }
            if ($answer === 'timeout') {
                throw new ConnectionException('timeout');
            }

            return Http::response($this->fixture('doh/'.$answer));
        });
    }

    public function test_doh_agreeing_resolvers_pass_with_chunked_txt_and_cname(): void
    {
        $this->fakeDoh(['_storeplix-verify.shop.acme.com|TXT' => 'txt_ok', 'shop.acme.com|CNAME' => 'cname_ok']);
        $result = $this->consensus()->verify('shop.acme.com', '_storeplix-verify.shop.acme.com', 'sp-verify=abcdefghijklmnop', 'customers.storeplix.test');
        $this->assertTrue($result->passed());
        $this->assertSame(['cloudflare' => 'ok', 'google' => 'ok'], $result->resolvers);
        $this->assertSame('cname', $result->routing['mode']);

        // S43: only the two DoH hosts were called, the merchant host only as a query parameter; JSON accept header.
        Http::assertSent(fn (Request $r) => in_array(parse_url($r->url(), PHP_URL_HOST), ['cloudflare-dns.com', 'dns.google'], true)
            && $r->hasHeader('Accept', 'application/dns-json'));
        Http::assertNotSent(fn (Request $r) => ! in_array(parse_url($r->url(), PHP_URL_HOST), ['cloudflare-dns.com', 'dns.google'], true));
        Http::assertSent(fn (Request $r) => str_starts_with($r->url(), 'https://cloudflare-dns.com/dns-query?'));
        Http::assertSent(fn (Request $r) => str_starts_with($r->url(), 'https://dns.google/resolve?'));
    }

    public function test_cname_chain_through_the_a_answer(): void
    {
        $this->fakeDoh([
            '_storeplix-verify.shop.acme.com|TXT' => 'txt_ok',
            'shop.acme.com|CNAME' => 'noerror_empty',
            'shop.acme.com|A' => 'a_chain',
        ]);
        $result = $this->consensus()->verify('shop.acme.com', '_storeplix-verify.shop.acme.com', 'sp-verify=abcdefghijklmnop', 'customers.storeplix.test');
        $this->assertTrue($result->passed());
    }

    public function test_missing_mismatch_and_inconclusive(): void
    {
        $this->fakeDoh([]);
        $r = $this->consensus()->verify('shop.acme.com', '_storeplix-verify.shop.acme.com', 'sp-verify=x', 'customers.storeplix.test');
        $this->assertSame(['fail', 'missing', 'missing', 'txt_missing'], [$r->outcome, $r->ownership['status'], $r->routing['status'], $r->failureCode()?->value]);

        // resolvers disagree → mismatch
        $this->fakeDoh(['_storeplix-verify.shop.acme.com|TXT' => 'txt_ok', 'shop.acme.com|CNAME' => 'cname_ok'], ['shop.acme.com|CNAME' => 'cname_ok']);
        $r = $this->consensus()->verify('shop.acme.com', '_storeplix-verify.shop.acme.com', 'sp-verify=abcdefghijklmnop', 'customers.storeplix.test');
        $this->assertSame(['fail', 'mismatch', 'ok'], [$r->outcome, $r->ownership['status'], $r->routing['status']]);

        foreach (['servfail', 500, 'timeout'] as $broken) {
            $this->fakeDoh(['_storeplix-verify.shop.acme.com|TXT' => 'txt_ok', 'shop.acme.com|CNAME' => 'cname_ok'],
                ['_storeplix-verify.shop.acme.com|TXT' => $broken, 'shop.acme.com|CNAME' => 'cname_ok']);
            $r = $this->consensus()->verify('shop.acme.com', '_storeplix-verify.shop.acme.com', 'sp-verify=abcdefghijklmnop', 'customers.storeplix.test');
            $this->assertSame('inconclusive', $r->outcome, (string) $broken);
            $this->assertSame('dns_error', $r->failureCode()?->value);
            $this->assertSame(['cloudflare' => 'ok', 'google' => 'error'], $r->resolvers);
        }
    }

    public function test_cloudflare_create_get_list_delete(): void
    {
        config(['domains.cloudflare.api_token' => self::TOKEN, 'domains.cloudflare.zone_id' => 'zone123']);
        Log::spy();
        Http::fake([
            'api.cloudflare.com/client/v4/zones/zone123/custom_hostnames/missing' => Http::response($this->fixture('cloudflare/not_found'), 404),
            'api.cloudflare.com/client/v4/zones/zone123/custom_hostnames/0d89*' => fn (Request $r) => $r->method() === 'DELETE'
                ? Http::response($this->fixture('cloudflare/delete')) : Http::response($this->fixture('cloudflare/get_active')),
            'api.cloudflare.com/client/v4/zones/zone123/custom_hostnames?*' => Http::response($this->fixture('cloudflare/list_one')),
            'api.cloudflare.com/client/v4/zones/zone123/custom_hostnames' => Http::response($this->fixture('cloudflare/create')),
        ]);
        $cf = new CloudflareCustomHostnames;

        $created = $cf->create('shop.acme.com');
        $this->assertSame(['0d89c70d-ad9f-4843-b99f-6cc0252067e9', 'pending', 'initializing', 'pending'], [$created->id, $created->status, $created->sslStatus, $created->sslState()]);
        Http::assertSent(fn (Request $r) => $r->method() === 'POST' && $r->hasHeader('Authorization', 'Bearer '.self::TOKEN)
            && $r['hostname'] === 'shop.acme.com' && $r['ssl'] === ['method' => 'http', 'type' => 'dv', 'settings' => ['min_tls_version' => '1.2']]);

        $this->assertTrue($cf->get('0d89c70d-ad9f-4843-b99f-6cc0252067e9')->isLive());
        $this->assertNull($cf->get('missing'));
        $cf->delete('missing'); // 404 = already gone
        $cf->delete('0d89c70d-ad9f-4843-b99f-6cc0252067e9');
        $this->assertSame('shop.acme.com', $cf->findByHostname('shop.acme.com')?->hostname);
        $this->assertNull($cf->findByHostname('other.acme.com'));
        $this->assertFalse($cf->list(1)['has_more']);

        // S50: the token never reaches a log line
        Log::shouldHaveReceived('info')->withArgs(fn ($msg, $ctx = []) => ! str_contains((string) json_encode([$msg, $ctx]), self::TOKEN));
    }

    public function test_cloudflare_errors(): void
    {
        config(['domains.cloudflare.api_token' => self::TOKEN, 'domains.cloudflare.zone_id' => 'zone123']);
        $cf = new CloudflareCustomHostnames;

        $this->freshHttp();
        Http::fake(['*' => Http::response($this->fixture('cloudflare/duplicate'), 409)]);
        $this->assertProviderError(fn () => $cf->create('shop.acme.com'), ProviderException::DUPLICATE);

        $this->freshHttp();
        Http::fake(['*' => Http::response($this->fixture('cloudflare/auth_error'), 403)]);
        Log::spy();
        $this->assertProviderError(fn () => $cf->get('x'), ProviderException::AUTH);
        Log::shouldHaveReceived('error')->withArgs(fn ($m) => $m === 'domains.provider_auth_failed');

        $this->freshHttp();
        Http::fake(['*' => Http::response('', 502)]);
        $this->assertProviderError(fn () => $cf->get('x'), ProviderException::ERROR);

        $this->freshHttp();
        Http::fake(['*' => fn () => throw new ConnectionException('timeout')]);
        $this->assertProviderError(fn () => $cf->list(1), ProviderException::ERROR);

        config(['domains.cloudflare.api_token' => '']);
        $this->assertProviderError(fn () => $cf->get('x'), ProviderException::AUTH);
    }

    /** Each scenario gets its own fake (Http::fake stubs accumulate, the first match wins). */
    private function freshHttp(): void
    {
        Http::swap(new Factory);
        Http::preventStrayRequests();
    }

    private function assertProviderError(callable $fn, string $kind): void
    {
        try {
            $fn();
            $this->fail('no ProviderException');
        } catch (ProviderException $e) {
            $this->assertSame($kind, $e->kind);
            $this->assertStringNotContainsString(self::TOKEN, $e->getMessage());
        }
    }
}
