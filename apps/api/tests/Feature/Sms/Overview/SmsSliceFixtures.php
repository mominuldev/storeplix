<?php

declare(strict_types=1);

namespace Tests\Feature\Sms\Overview;

use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Models\Plan;
use App\Domain\Billing\Models\Subscription;
use App\Domain\Identity\Models\User;
use App\Domain\Media\Models\Media;
use App\Domain\Sms\Credits\SmsCreditService;
use App\Domain\Sms\Models\SmsMessage;
use App\Domain\Sms\Models\SmsSenderId;
use App\Domain\Sms\SmsGateway;
use App\Domain\Sms\SmsSender;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Models\Tenant;
use Database\Seeders\PlanSeeder;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;

/** PHASE-8-9A overview / templates / log helpers (on top of CommerceFixtures). */
trait SmsSliceFixtures
{
    protected function smsShop(string $slug = 'shop'): array
    {
        $this->seed(PlanSeeder::class);
        $shop = $this->liveShop($slug);
        $this->onPlan($shop[1], Plan::FREE); // sms_per_month 200, campaign_sms_per_month 0

        return $shop;
    }

    protected function onPlan(Tenant $tenant, string $code): void
    {
        $this->tenancy()->run($tenant, fn () => Subscription::query()->update(['plan_id' => Plan::query()->where('code', $code)->value('id'), 'status' => Subscription::ACTIVE]));
        FeatureGate::forget($tenant->id);
    }

    protected function grantCredits(Tenant $tenant, int $credits): void
    {
        $this->inTenant($tenant, fn () => DB::transaction(function () use ($credits) {
            $svc = app(SmsCreditService::class);
            $svc->append($svc->lockAccount(), 'admin_adjust', $credits, ['reason' => 'Test grant']);
        }));
    }

    protected function balance(Tenant $tenant): int
    {
        return $this->inTenant($tenant, fn () => app(SmsCreditService::class)->balance());
    }

    protected function verifiedPhone(User $user, string $phone = '8801711552211'): void
    {
        $user->forceFill(['phone' => $phone, 'phone_verified_at' => now()])->save();
    }

    /** Inserts sms_messages rows directly. @param array<string, mixed> $attrs */
    protected function smsRow(Tenant|string|null $tenant, ?Store $store, array $attrs = []): string
    {
        $id = strtolower((string) Str::ulid());
        $this->platformQuery(SmsMessage::class)->insert($attrs + [
            'id' => $id, 'tenant_id' => $tenant instanceof Tenant ? $tenant->id : $tenant, 'store_id' => $store?->id,
            'to' => '8801711552211', 'purpose' => 'order_placed', 'template' => 'order_placed.bn', 'status' => 'sent',
            'kind' => 'transactional', 'parts' => 1, 'charged_from' => 'allowance', 'credits_charged' => 0,
            'created_at' => now(), 'updated_at' => now(),
        ]);

        return $id;
    }

    /** Fills the free transactional allowance (200) with sent rows. */
    protected function useUpAllowance(Tenant $tenant, Store $store, int $count = 200): void
    {
        $rows = array_map(fn () => ['id' => strtolower((string) Str::ulid()), 'tenant_id' => $tenant->id, 'store_id' => $store->id, 'to' => '8801700000000',
            'purpose' => 'order_placed', 'template' => 'order_placed.bn', 'status' => 'sent', 'credits_charged' => 0, 'created_at' => now(), 'updated_at' => now()], range(1, $count));
        foreach (array_chunk($rows, 100) as $chunk) {
            $this->platformQuery(SmsMessage::class)->insert($chunk);
        }
    }

    /** @return list<array{to: string, text: string, sender_id: string|null}> */
    protected function sent(): array
    {
        return app(SmsGateway::class)->sent;
    }

    /** An approved (or pending) sender ID row for the store, with a private PDF document. */
    protected function senderRow(Tenant $tenant, Store $store, string $senderId = 'SHOPBD', string $status = 'approved'): string
    {
        return $this->inTenant($tenant, function () use ($store, $senderId, $status) {
            $media = new Media;
            $media->forceFill(['purpose' => 'sender_id_document', 'disk' => 'local', 'path' => 'tenants/x/'.Str::ulid().'.pdf', 'mime' => 'application/pdf',
                'size_bytes' => 1234, 'width' => 0, 'height' => 0, 'checksum' => str_repeat('a', 64), 'status' => 'ready', 'variants' => []])->save();
            $row = new SmsSenderId;
            $row->forceFill(['store_id' => $store->id, 'sender_id' => $senderId, 'business_name' => 'Shop Ltd', 'uses' => ['order_updates'],
                'status' => $status, 'document_media_id' => $media->id, 'rights_confirmed_at' => now(), 'requested_at' => now(),
                'approved_at' => $status === 'approved' ? now() : null])->save();
            SmsSender::forget($store->id);

            return $row->id;
        });
    }

    /**
     * Cross-tenant resource access (MULTI-TENANCY §10a): every URL → 404 not_found.
     *
     * @param  list<array{0: string, 1: string, 2?: array<string, mixed>}>  $requests
     */
    protected function assertTenantIsolation(array $headersA, array $requests): void
    {
        foreach ($requests as $request) {
            $this->flushHeaders()->withHeaders($headersA)->json($request[0], $request[1], $request[2] ?? [])
                ->assertNotFound()->assertJsonPath('error.code', 'not_found');
        }
    }

    protected function smsUrl(Store $store, string $suffix = ''): string
    {
        return "/api/v1/stores/{$store->id}/sms{$suffix}";
    }
}
