<?php

namespace Tests\Support;

use App\Domain\Identity\Models\User;
use Illuminate\Testing\TestResponse;
use Tests\Fixtures\StrictCsrf;

/**
 * A simulated SPA browser for cookie-session tests (Phase 4.7): one cookie jar, Referer of the merchant SPA,
 * X-XSRF-TOKEN on writes, strict CSRF (the framework skips CSRF in tests otherwise) and a database session store
 * re-read from the cookie on every request, like separate HTTP calls.
 */
trait SpaBrowser
{
    protected string $spaOrigin = 'http://localhost:5183';

    /** @var array<string, string> raw (encrypted) cookies */
    protected array $jar = [];

    protected function useSpaBrowser(): void
    {
        config([
            'session.driver' => 'database',
            'sanctum.stateful' => ['localhost:5183', 'localhost:5184'],
            'sanctum.middleware.validate_csrf_token' => StrictCsrf::class,
        ]);
    }

    protected function freshSession(): void
    {
        $this->app['session']->forgetDrivers();
        $this->app->forgetInstance('session.store');
    }

    /** @param array<string, string> $headers */
    protected function browser(string $method, string $uri, array $data = [], array $headers = [], bool $csrf = true): TestResponse
    {
        $headers += ['Referer' => $this->spaOrigin.'/', 'Accept' => 'application/json'];
        if ($csrf && $method !== 'GET' && isset($this->jar['XSRF-TOKEN'])) {
            $headers['X-XSRF-TOKEN'] = urldecode($this->jar['XSRF-TOKEN']);
        }
        $this->freshSession();
        $response = $this->flushHeaders()->withCredentials()->withUnencryptedCookies($this->jar)->withHeaders($headers)->json($method, $uri, $data);
        foreach ($response->headers->getCookies() as $cookie) {
            // Judge expiry on the app clock, not Symfony's isCleared() (real time()): tests that travelTo() a fixed past
            // date get cookies that "expired" in real time once that date is a few hours behind the wall clock.
            if ($cookie->getExpiresTime() !== 0 && $cookie->getExpiresTime() < now()->getTimestamp()) {
                unset($this->jar[$cookie->getName()]);
            } else {
                $this->jar[$cookie->getName()] = $cookie->getValue();
            }
        }

        return $response;
    }

    protected function spaLogin(User $user, string $password = 'password'): TestResponse
    {
        $this->browser('GET', '/sanctum/csrf-cookie')->assertNoContent();

        return $this->browser('POST', '/api/v1/auth/login', ['email' => $user->email, 'password' => $password])->assertOk();
    }
}
