<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\Platform;

use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Identity\Models\User;
use App\Domain\Sms\Drivers\FakeSmsGateway;
use App\Domain\Sms\Models\SmsProvider;
use App\Domain\Sms\Providers\SmsHostResolver;
use App\Domain\Sms\Routing\SmsRoutingTable;
use App\Domain\Sms\SmsGateway;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Contracts\Events\Dispatcher;
use Illuminate\Http\Client\Factory as HttpFactory;
use Illuminate\Support\Carbon;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Http;
use Illuminate\Testing\TestResponse;
use Tests\Support\PlatformStaffFixtures;

/**
 * PHASE-8-9B test helpers: a super admin on the admin surface, DNS answered without the network (public address),
 * REVE / HTTP provider endpoints faked with Http::fake, merchant owners with verified phones and subscriptions.
 */
trait PlatformSmsFixtures
{
    use PlatformStaffFixtures;

    protected const REVE_URL = 'https://api.reve.example';

    protected const API_KEY = 'APIKEY-1234567890-SECRETVALUE';

    protected const SECRET_KEY = 'SECRETKEY-abcdefghij-9f3a';

    protected ?User $super = null;

    private int $phoneSeq = 0;

    protected function setUpPlatformSms(): void
    {
        config(['admin.ip_allowlist' => [], 'admin.email_domains' => [], 'sms.platform.test_per_hour' => 1000]);
        $this->app->instance(SmsHostResolver::class, new class extends SmsHostResolver
        {
            public function resolve(string $host): array
            {
                return match (true) {
                    str_contains($host, 'rebind') => ['10.0.0.8'],
                    str_contains($host, 'nxdomain') => [],
                    default => ['93.184.216.34'],
                };
            }
        });
        Cache::flush();
        SmsRoutingTable::flush();
    }

    protected function super(): User
    {
        return $this->super ??= $this->staffUser(PlatformRole::SuperAdmin);
    }

    /** @param array<string, mixed> $body */
    protected function admin(string $method, string $uri, array $body = [], ?User $as = null): TestResponse
    {
        return $this->asAdminSurface()->flushHeaders()->withHeaders($this->adminHeaders($as ?? $this->super()))
            ->json($method, '/api/v1/admin/sms/'.ltrim($uri, '/'), $body);
    }

    /** Switches the binding to the router (SMS_DRIVER=revesms) — with env REVE keys unless `$env` is false. */
    protected function useRouter(bool $env = true): void
    {
        config(['sms.driver' => 'revesms', 'sms.revesms' => [
            'base_url' => 'https://smpp.env-reve.example:7790', 'api_key' => $env ? 'ENV-API-KEY-0001' : null,
            'secret_key' => $env ? 'ENV-SECRET-KEY-0002' : null, 'caller_id' => 'StorePlix', 'timeout' => 10, 'retries' => 2,
        ]]);
        $this->app->forgetInstance(SmsGateway::class);
        SmsRoutingTable::flush();
    }

    protected function fake(): FakeSmsGateway
    {
        /** @var FakeSmsGateway $fake */
        $fake = app(SmsGateway::class);

        return $fake;
    }

    /** A fresh Http fake (Http::fake() stubs stack and the first match wins). @param array<string, mixed>|callable $stubs */
    protected function httpFake(array|callable $stubs): void
    {
        Http::swap(new HttpFactory(app(Dispatcher::class)));
        Http::preventStrayRequests();
        Http::fake($stubs);
    }

    /** REVE answers: every send accepted, balance ৳2,500.50 unless given. */
    protected function reveOk(string $host = 'api.reve.example', string $balance = '2500.50'): void
    {
        $this->httpFake([
            "{$host}/sendtext" => Http::response(['Status' => '0', 'Text' => 'ACCEPTD', 'Message_ID' => 9001]),
            "{$host}/getbalance" => Http::response(['Status' => '0', 'Balance' => $balance]),
            '*' => Http::response(['Status' => '0', 'Message_ID' => 1, 'Balance' => '100']),
        ]);
    }

    /** @param array<string, mixed> $over */
    protected function reveInput(array $over = []): array
    {
        return array_replace_recursive([
            'driver' => 'revesms', 'name' => 'REVE Main',
            'credentials' => ['api_key' => self::API_KEY, 'secret_key' => self::SECRET_KEY],
            'settings' => ['account_id' => 'ACC-77', 'base_url' => self::REVE_URL],
            'default_sender_id' => 'Storeplix', 'promotional_sender_id' => 'StorePlixP', 'promotional_sender_status' => 'approved',
            'message_groups' => ['shop', 'registration', 'billing', 'security', 'promotional'],
        ], $over);
    }

    /** @param array<string, mixed> $over */
    protected function httpInput(array $over = []): array
    {
        return array_replace_recursive([
            'driver' => 'http', 'name' => 'Alpha via HTTP',
            'credentials' => ['api_key' => 'HTTP-KEY-abcdef-7788'],
            'settings' => ['account_id' => null, 'base_url' => 'https://alpha.example/api/send', 'http' => [
                'method' => 'POST', 'body_format' => 'form', 'to_param' => 'to', 'text_param' => 'msg', 'sender_param' => 'sender_id',
                'credential_params' => ['api_key' => 'api_key'], 'success_path' => 'response_code', 'success_value' => '202', 'message_id_path' => 'data.request_id',
            ]],
            'default_sender_id' => 'Storeplix',
            'message_groups' => ['shop', 'registration', 'billing', 'security'],
        ], $over);
    }

    /** Creates a provider through the API and returns its id. @param array<string, mixed> $input */
    protected function createProvider(array $input): string
    {
        return (string) $this->admin('POST', 'providers', $input)->assertCreated()->json('data.id');
    }

    /** Creates, tests (passing) and activates a provider through the API. */
    protected function activeProvider(array $input, string $role = 'primary', bool $keep = true): string
    {
        $id = $this->createProvider($input);
        $this->admin('POST', "providers/{$id}/test", ['phone' => '01711000001'])->assertOk()->assertJsonPath('data.status', 'passed');
        $this->admin('POST', "providers/{$id}/activate", ['role' => $role, 'confirm_name' => $input['name'], 'keep_previous_as_failover' => $keep])->assertOk();

        return $id;
    }

    protected function provider(string $id): SmsProvider
    {
        return $this->platformQuery(SmsProvider::class)->findOrFail($id);
    }

    /**
     * A merchant owner with a store and a subscription.
     *
     * @return array{0: User, 1: Tenant, 2: Store}
     */
    protected function owner(string $slug, string $plan = 'growth', string $status = Subscription::ACTIVE, bool $verified = true, string $language = 'bn', ?Carbon $trialEnds = null): array
    {
        [$user, $tenant] = $this->merchant();
        $this->phoneSeq++;
        $user->forceFill(['name' => ucfirst($slug).' Owner', 'phone' => '88017'.str_pad((string) (11000000 + $this->phoneSeq + random_int(0, 80000) * 10), 8, '0', STR_PAD_LEFT),
            'phone_verified_at' => $verified ? now() : null])->save();
        $store = $this->storeFor($tenant, $slug);
        $this->inTenant($tenant, function () use ($store, $plan, $status, $language, $trialEnds) {
            StoreSetting::query()->where('store_id', $store->id)->update(['sms_language' => $language]);
            Subscription::query()->whereIn('status', Subscription::CURRENT_STATUSES)->delete();
            (new Subscription)->forceFill([
                'plan_id' => Plan::query()->where('code', $plan)->value('id'), 'status' => $status, 'billing_interval' => Plan::MONTH,
                'trial_ends_at' => $trialEnds, 'current_period_start' => now(), 'current_period_end' => now()->addMonth(),
            ] + ($status === Subscription::PAST_DUE ? ['past_due_at' => now(), 'grace_ends_at' => now()->addDays(7)] : []))->save();
        });

        return [$user->refresh(), $tenant, $store];
    }
}
