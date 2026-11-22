<?php

declare(strict_types=1);

namespace App\Domain\Payments\Jobs;

use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Payment;
use App\Domain\Payments\Models\PaymentLink;
use App\Domain\Payments\PaymentLinkService;
use App\Domain\Payments\PaymentService;
use App\Domain\Tenancy\Queue\TenantAware;
use Illuminate\Contracts\Queue\ShouldBeUnique;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * One tenant's share of a payments schedule (§2.4 B11: the command finds tenants with work on the platform connection,
 * this job does the work inside the tenant). Kinds:
 *  - expire:        pending_payment orders past payment_expires_at (P5B-21, query first)
 *  - reconcile:     pending online charges older than 2 min (P5B-19 safety net)
 *  - refund-status: pending gateway refunds the provider reported as processing (P5B-24)
 *  - links:         active payment links past expires_at (P5B-22)
 * Each item is isolated: one failing order never blocks the rest.
 */
class RunPaymentSweep implements ShouldBeUnique, ShouldQueue
{
    use Queueable, TenantAware;

    public const EXPIRE = 'expire';

    public const RECONCILE = 'reconcile';

    public const REFUND_STATUS = 'refund-status';

    public const LINKS = 'links';

    public const BATCH = 200;

    public int $timeout = 300;

    public int $uniqueFor = 300;

    public function __construct(public readonly string $kind, string $tenantId)
    {
        $this->tenantId = $tenantId;
    }

    public function uniqueId(): string
    {
        return $this->kind.':'.$this->tenantId;
    }

    public function handle(PaymentService $payments, PaymentLinkService $links): void
    {
        $items = match ($this->kind) {
            self::EXPIRE => Order::query()->where('status', Order::PENDING_PAYMENT)->where('payment_expires_at', '<=', now())->orderBy('payment_expires_at')->limit(self::BATCH)->get(),
            self::RECONCILE => Payment::query()->where('type', Payment::TYPE_CHARGE)->where('status', Payment::STATUS_PENDING)
                ->whereIn('provider', Payment::ONLINE_PROVIDERS)->where('created_at', '<=', now()->subMinutes(2))->orderBy('created_at')->limit(self::BATCH)->get(),
            self::REFUND_STATUS => Payment::query()->where('type', Payment::TYPE_REFUND)->where('status', Payment::STATUS_PENDING)
                ->whereIn('provider', Payment::ONLINE_PROVIDERS)->where('created_at', '<=', now()->subMinute())->orderBy('created_at')->limit(self::BATCH)->get(),
            self::LINKS => PaymentLink::query()->where('status', PaymentLink::ACTIVE)->where('expires_at', '<=', now())->orderBy('expires_at')->limit(self::BATCH)->get(),
            default => collect(),
        };
        foreach ($items as $item) {
            try {
                match ($this->kind) {
                    self::EXPIRE => $payments->expireOrder($item),
                    self::RECONCILE => $payments->verify($item),
                    self::REFUND_STATUS => $payments->syncRefund($item),
                    self::LINKS => $links->expire($item),
                };
            } catch (Throwable $e) {
                report($e);
                Log::warning('payments.sweep_item_failed', ['kind' => $this->kind, 'id' => $item->getKey()]);
            }
        }
    }
}
