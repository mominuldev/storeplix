<?php

declare(strict_types=1);

namespace Tests\Feature\Inbox;

use App\Domain\Inbox\Models\InboxConversation;
use App\Domain\Inbox\Models\InboxMessage;
use App\Domain\Sms\Drivers\FakeSmsGateway;
use App\Domain\Sms\SmsGateway;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use Carbon\CarbonImmutable;
use Illuminate\Contracts\Filesystem\Filesystem;
use Illuminate\Http\UploadedFile;
use Illuminate\Routing\Middleware\ThrottleRequests;
use Illuminate\Support\Facades\Storage;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;
use Tests\Feature\Expenses\ExpenseFixtures;
use Tests\Support\CommerceFixtures;

/**
 * Phase 8.8e helpers: a live shop with Inbox channels on, the storefront chat (code from the fake SMS gateway),
 * order access, inbound mail signed for the `fake` driver, and conversations / messages through the API.
 */
trait InboxFixtures
{
    use CommerceFixtures, ExpenseFixtures {
        ExpenseFixtures::upload as expenseUpload;
    }

    protected const PHONE = '01711000222';

    protected const MSISDN = '8801711000222';

    protected function setUpInbox(bool $throttle = false): void
    {
        $this->setUpExpenses($throttle);
        config([
            'inbox.mail_domain' => 'in.storeplix.test',
            'inbox.inbound_driver' => 'fake',
            'inbox.fake.signing_key' => 'test-inbound-key',
        ]);
    }

    protected function sms(): FakeSmsGateway
    {
        /** @var FakeSmsGateway $gateway */
        $gateway = app(SmsGateway::class);

        return $gateway;
    }

    protected function iUrl(Store $store, string $suffix = ''): string
    {
        return "/api/v1/stores/{$store->id}/inbox".$suffix;
    }

    /** @param array<string, mixed> $body */
    protected function channels(array $h, Store $store, array $body = ['web_chat_enabled' => true, 'order_messages_enabled' => true, 'email_enabled' => true]): array
    {
        $revision = $this->api($h, 'GET', $this->iUrl($store, '/settings'))->assertOk()->json('data.revision');

        return $this->api($h, 'PATCH', $this->iUrl($store, '/settings'), $body + ['revision' => $revision])->assertOk()->json('data');
    }

    /** A live shop (delivery zones, contact) with every channel on. @return array{0: \App\Domain\Identity\Models\User, 1: Tenant, 2: Store, 3: array<string, string>} */
    protected function inboxShop(string $slug = 'inbox'): array
    {
        [$user, $tenant, $store, $h] = $this->liveShop($slug);
        $this->channels($h, $store);

        return [$user, $tenant, $store, $h];
    }

    /** @param array<string, mixed> $fields */
    protected function startChat(Store $store, array $fields = [], ?UploadedFile $file = null, array $extra = []): TestResponse
    {
        $body = $fields + ['name' => 'Rafi Ahmed', 'phone' => self::PHONE, 'message' => 'Is this in stock?', 'client_id' => (string) Str::uuid()];
        if ($file !== null) {
            $body['file'] = $file;
        }

        return $this->sfMultipart($store, 'POST', '/inbox/sessions', $body, $extra);
    }

    /** @param array<string, mixed> $body @param array<string, string|null> $extra */
    protected function sfMultipart(Store $store, string $method, string $path, array $body, array $extra = []): TestResponse
    {
        $headers = array_filter(array_merge([
            'X-Storefront-Key' => (string) config('storeplix.storefront_api_key'),
            'X-Storefront-Host' => $this->host($store),
            'X-Storefront-Client-Ip' => '203.0.113.'.random_int(1, 250),
            'Accept' => 'application/json',
        ], $extra), fn ($v) => $v !== null);

        return $this->flushHeaders()->withHeaders($headers)->call($method, '/api/v1/storefront'.$path, $body, [], array_filter($body, fn ($v) => $v instanceof UploadedFile),
            $this->transformHeadersToServerVars($headers));
    }

    protected function chat(Store $store, string $token, string $method, string $path, array $body = [], array $extra = []): TestResponse
    {
        return $this->sf($store, $method, '/inbox'.$path, $body, null, ['X-Inbox-Session' => $token] + $extra);
    }

    /** A verified chat: [session token, conversation id]. @return array{0: string, 1: string} */
    protected function verifiedChat(Tenant $tenant, Store $store, string $message = 'Is this in stock?', string $phone = self::PHONE): array
    {
        $token = $this->startChat($store, ['message' => $message, 'phone' => $phone])->assertCreated()->assertJsonPath('data.status', 'code_sent')->json('data.session_token');
        $code = $this->sms()->lastCodeFor('88'.$phone);
        $this->chat($store, $token, 'POST', '/sessions/verify', ['code' => $code])->assertOk()->assertJsonPath('data.status', 'verified');

        return [$token, $this->conversationOf($tenant, 'web_chat')->id];
    }

    protected function conversationOf(Tenant $tenant, string $channel): InboxConversation
    {
        return $this->platformQuery(InboxConversation::class)->where('tenant_id', $tenant->id)->where('channel', $channel)->orderByDesc('created_at')->firstOrFail();
    }

    protected function conversationRow(Tenant $tenant, string $id): ?InboxConversation
    {
        return $this->platformQuery(InboxConversation::class)->where('tenant_id', $tenant->id)->whereKey($id)->first();
    }

    /** @return list<InboxMessage> */
    protected function messagesOf(Tenant $tenant, string $conversationId): array
    {
        return $this->platformQuery(InboxMessage::class)->where('tenant_id', $tenant->id)->where('conversation_id', $conversationId)->orderBy('id')->get()->all();
    }

    /** @param array<string, mixed> $body */
    protected function reply(array $h, Store $store, string $conversation, string $text = 'Yes, in stock.', array $body = []): TestResponse
    {
        return $this->api($h, 'POST', $this->iUrl($store, "/conversations/{$conversation}/messages"), $body + [
            'kind' => 'reply', 'body' => $text, 'client_id' => (string) Str::uuid(),
        ]);
    }

    protected function inboxUpload(array $h, Store $store, string $name, string $bytes): TestResponse
    {
        $file = UploadedFile::fake()->createWithContent($name, $bytes);

        return $this->flushHeaders()->withHeaders($h)->post($this->iUrl($store, '/attachments'), ['file' => $file], ['Accept' => 'application/json']);
    }

    /** Mailgun-format inbound post signed for the fake driver. @param array<string, mixed> $fields */
    protected function inbound(array $fields, ?string $key = 'test-inbound-key', ?int $timestamp = null, ?string $token = null): TestResponse
    {
        $timestamp ??= now()->getTimestamp();
        $token ??= Str::random(50);
        $signature = hash_hmac('sha256', $timestamp.$token, (string) $key);
        $body = $fields + ['timestamp' => (string) $timestamp, 'token' => $token, 'signature' => $signature,
            'from' => 'Nusrat <nusrat@example.test>', 'subject' => 'Delivery?', 'body-plain' => 'When will it arrive?',
            'Message-Id' => '<'.Str::random(12).'@mail.example.test>', 'X-Mailgun-Spf' => 'Pass'];
        $files = array_filter($body, fn ($v) => $v instanceof UploadedFile);

        return $this->flushHeaders()->call('POST', '/api/v1/webhooks/inbound-email/fake', array_diff_key($body, $files), [], $files, ['HTTP_ACCEPT' => 'application/json']);
    }

    protected function storeAddress(Tenant $tenant, Store $store): string
    {
        return (string) $this->platformTable('inbox_settings')->where('tenant_id', $tenant->id)->where('store_id', $store->id)->value('email_key');
    }

    /** A COD order placed on the storefront (the confirmation token). @return array{0: string, 1: string, 2: string} order id, number, token */
    protected function sfOrder(array $h, Store $store): array
    {
        [, $variant] = $this->stocked($h, $store);
        $r = $this->placeOrder($store, $variant);
        $number = $r->json('data.order.number');
        $id = (string) $this->platformTable('orders')->where('store_id', $store->id)->where('number', $number)->value('id');

        return [$id, $number, $r->json('data.confirmation_token')];
    }

    protected function at(string $utc = self::NOW_UTC): void
    {
        $this->travelTo(CarbonImmutable::parse($utc, 'UTC'));
    }

    protected function withoutThrottle(): void
    {
        $this->withoutMiddleware(ThrottleRequests::class);
    }

    protected function pdfFile(string $name = 'invoice.pdf'): UploadedFile
    {
        return UploadedFile::fake()->createWithContent($name, self::pdf());
    }

    protected function pngFile(string $name = 'photo.png'): UploadedFile
    {
        return UploadedFile::fake()->createWithContent($name, $this->imageBytes(120, 120, 'png'));
    }

    protected static function storageDisk(): Filesystem
    {
        return Storage::disk('local');
    }
}
