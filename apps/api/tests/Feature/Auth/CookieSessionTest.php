<?php

namespace Tests\Feature\Auth;

use App\Domain\Identity\Models\User;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\DB;
use PHPUnit\Framework\Attributes\Group;
use Symfony\Component\HttpFoundation\Cookie;
use Tests\Support\SpaBrowser;
use Tests\TestCase;

/** Phase 4.7 (§7.5): same-origin cookie sessions with CSRF; 4.7c: no Bearer tokens. */
#[Group('security')]
class CookieSessionTest extends TestCase
{
    use RefreshDatabase, SpaBrowser;

    protected function setUp(): void
    {
        parent::setUp();
        $this->useSpaBrowser();
    }

    public function test_stateful_login_sets_host_only_httponly_lax_session_cookie_and_no_token(): void
    {
        $user = User::factory()->create();
        $csrf = $this->browser('GET', '/sanctum/csrf-cookie')->assertNoContent();
        $xsrf = collect($csrf->headers->getCookies())->first(fn (Cookie $c) => $c->getName() === 'XSRF-TOKEN');
        $this->assertFalse($xsrf->isHttpOnly());
        $before = $this->jar[config('session.cookie')];

        $login = $this->browser('POST', '/api/v1/auth/login', ['email' => $user->email, 'password' => 'password'])->assertOk()
            ->assertJsonStructure(['data' => ['user', 'expires_at']])->assertJsonMissingPath('data.token');
        /** @var Cookie $session */
        $session = collect($login->headers->getCookies())->first(fn (Cookie $c) => $c->getName() === config('session.cookie'));
        $this->assertTrue($session->isHttpOnly());
        $this->assertSame('lax', $session->getSameSite());
        $this->assertNull($session->getDomain());
        $this->assertSame('/', $session->getPath());
        $this->assertNotSame($before, $session->getValue()); // regenerated on login
        $this->assertSame(0, DB::table('personal_access_tokens')->count());

        $me = $this->browser('GET', '/api/v1/auth/me')->assertOk()->assertJsonPath('data.id', $user->id);
        $this->assertSame($login->json('data.expires_at'), $me->json('meta.session_expires_at'));
    }

    public function test_write_without_csrf_token_is_419(): void
    {
        $this->spaLogin(User::factory()->create());
        $this->browser('PATCH', '/api/v1/auth/me', ['name' => 'X'], csrf: false)
            ->assertStatus(419)->assertJsonPath('error.code', 'csrf_token_mismatch')
            ->assertJsonPath('error.message', 'Your session refreshed. Please try again.');
        $this->browser('PATCH', '/api/v1/auth/me', ['name' => 'With token'])->assertOk();
    }

    /**
     * Laravel 13 accepts a write without the token when the browser itself says `Sec-Fetch-Site: same-origin` (a
     * forbidden header no page script can set). Every other case needs the X-XSRF-TOKEN.
     */
    public function test_fetch_metadata_rules(): void
    {
        $this->spaLogin(User::factory()->create());
        $this->browser('PATCH', '/api/v1/auth/me', ['name' => 'Same origin'], ['Sec-Fetch-Site' => 'same-origin'], csrf: false)->assertOk();

        foreach (['cross-site', 'same-site', 'none'] as $site) {
            $this->browser('PATCH', '/api/v1/auth/me', ['name' => 'X'], ['Sec-Fetch-Site' => $site], csrf: false)
                ->assertStatus(419)->assertJsonPath('error.code', 'csrf_token_mismatch');
        }
        // A cross-site attacker page sends its own Origin/Referer → not stateful → the cookie is not even read.
        $this->browser('PATCH', '/api/v1/auth/me', ['name' => 'X'], ['Referer' => 'https://evil.test/', 'Origin' => 'https://evil.test', 'Sec-Fetch-Site' => 'cross-site'], csrf: false)
            ->assertUnauthorized();
    }

    public function test_storefront_origin_is_never_stateful(): void
    {
        $this->spaLogin(User::factory()->create());
        $this->browser('GET', '/api/v1/auth/me', headers: ['Referer' => 'http://demo.localhost:3010/', 'Origin' => 'http://demo.localhost:3010'])->assertUnauthorized();
    }

    public function test_session_past_absolute_expiry_is_401(): void
    {
        $this->spaLogin(User::factory()->create());
        $this->travel(10081)->minutes();
        $this->browser('GET', '/api/v1/auth/me')->assertUnauthorized()->assertJsonPath('error.code', 'unauthenticated');
    }

    public function test_logout_kills_the_session(): void
    {
        $this->spaLogin(User::factory()->create());
        $this->browser('POST', '/api/v1/auth/logout')->assertNoContent();
        $this->browser('GET', '/api/v1/auth/me')->assertUnauthorized();
    }

    public function test_password_change_rotates_session_and_logs_out_other_sessions(): void
    {
        $user = User::factory()->create();
        $this->spaLogin($user);
        $this->browser('GET', '/api/v1/auth/me')->assertOk(); // stores the password hash in session A
        $sessionA = $this->jar;

        $this->jar = [];
        $this->spaLogin($user);
        $this->browser('GET', '/api/v1/auth/me')->assertOk();
        $before = $this->jar[config('session.cookie')];
        $this->browser('PUT', '/api/v1/auth/password', ['current_password' => 'password', 'password' => 'N3w-passw0rd!x', 'password_confirmation' => 'N3w-passw0rd!x'])
            ->assertOk()->assertJsonStructure(['data' => ['user', 'expires_at']])->assertJsonMissingPath('data.token');
        $this->assertNotSame($before, $this->jar[config('session.cookie')]); // rotated
        $this->browser('GET', '/api/v1/auth/me')->assertOk(); // the current session survives

        $this->jar = $sessionA;
        $this->browser('GET', '/api/v1/auth/me')->assertUnauthorized();
    }

    /** 4.7c: sign-in from a non-SPA caller → 400 stateful_required; Bearer tokens authenticate nothing. */
    public function test_non_stateful_sign_in_and_bearer_are_refused(): void
    {
        $user = User::factory()->create();
        $this->flushHeaders()->withHeaders(['Origin' => 'https://script.test'])
            ->postJson('/api/v1/auth/login', ['email' => $user->email, 'password' => 'password'])
            ->assertStatus(400)->assertJsonPath('error.code', 'stateful_required')->assertJsonPath('error.message', 'Sign in from the Storeplix app.');
        $this->flushHeaders()->withHeaders(['Origin' => 'https://script.test'])
            ->postJson('/api/v1/auth/register', ['name' => 'X', 'email' => 'x@x.test', 'password' => 'secret-pass1', 'password_confirmation' => 'secret-pass1'])
            ->assertStatus(400);
        $this->assertSame(0, User::query()->where('email', 'x@x.test')->count());

        // A legacy token row (pre-4.7c) is useless, with or without a SPA Referer.
        $plain = 'legacy-token-value';
        DB::table('personal_access_tokens')->insert([
            'tokenable_type' => User::class, 'tokenable_id' => $user->id, 'name' => 'merchant-dashboard',
            'token' => hash('sha256', $plain), 'abilities' => '["*"]', 'created_at' => now(), 'updated_at' => now(),
        ]);
        $id = DB::table('personal_access_tokens')->value('id');
        foreach ([[], ['Referer' => 'http://localhost:5183/']] as $extra) {
            $this->flushHeaders()->withHeaders(['Authorization' => "Bearer {$id}|{$plain}", 'Origin' => 'https://script.test'] + $extra)
                ->getJson('/api/v1/auth/me')->assertUnauthorized();
        }
    }
}
