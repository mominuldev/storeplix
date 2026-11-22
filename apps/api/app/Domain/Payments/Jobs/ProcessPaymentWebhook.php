<?php

declare(strict_types=1);

namespace App\Domain\Payments\Jobs;

use App\Domain\Orders\Models\Payment;
use App\Domain\Payments\Gateways\GatewayException;
use App\Domain\Payments\Models\PaymentGatewayAccount;
use App\Domain\Payments\Models\WebhookEvent;
use App\Domain\Payments\PaymentManager;
use App\Domain\Payments\PaymentService;
use App\Domain\Tenancy\Queue\TenantAware;
use App\Domain\Webhooks\WebhookIngestor;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Processes one stored gateway event on the `webhooks` queue (P5B-19). The event is a TRIGGER only: SSLCommerz IPNs
 * are confirmed with the Validation API (`val_id`), bKash notifications with Query Payment; PaymentService decides.
 * The payment is looked up by our id (tran_id / merchantInvoiceNumber) WITHIN the event's tenant and store.
 */
class ProcessPaymentWebhook implements ShouldQueue
{
    use Queueable, TenantAware;

    public int $tries = 3;

    /** @var list<int> */
    public array $backoff = [30, 120];

    public function __construct(public readonly string $eventId) {}

    public function handle(PaymentService $payments, PaymentManager $gateways): void
    {
        $event = WebhookEvent::query()->find($this->eventId);
        if ($event === null || $event->status !== WebhookEvent::RECEIVED) {
            return;
        }
        $payload = (array) $event->payload;
        $reference = $event->provider === PaymentGatewayAccount::SSLCOMMERZ ? ($payload['tran_id'] ?? null) : ($payload['merchantInvoiceNumber'] ?? null);
        $payment = is_string($reference) ? Payment::query()->where('store_id', $event->store_id)->whereKey(strtolower(trim($reference)))
            ->where('type', Payment::TYPE_CHARGE)->where('provider', $event->provider)->first() : null;
        $account = PaymentGatewayAccount::query()->where('store_id', $event->store_id)->whereKey($event->account_id)->first();
        if ($payment === null || $account === null || $payment->gateway_account_id !== $account->id) {
            WebhookIngestor::finish($event, WebhookEvent::IGNORED, 'unknown_payment');

            return;
        }

        try {
            if ($event->provider === PaymentGatewayAccount::SSLCOMMERZ && is_string($payload['val_id'] ?? null)) {
                // Late successes are validated too (SSLCommerz already took the money; P5B-21 refunds them).
                if ($payment->status === Payment::STATUS_SUCCEEDED) {
                    WebhookIngestor::finish($event, WebhookEvent::PROCESSED);

                    return;
                }
                $verification = $gateways->driver($payment->provider)->complete($payment, $account, ['val_id' => $payload['val_id']]);
                $payments->apply($payment, $verification, 'webhook');
            } elseif ($payment->status === Payment::STATUS_PENDING) {
                $payments->verify($payment);
            }
            WebhookIngestor::finish($event, WebhookEvent::PROCESSED);
        } catch (GatewayException $e) {
            Log::warning('payments.webhook_unverified', ['event_id' => $event->id, 'payment_id' => $payment->id, 'code' => $e->errorCode]);
            if ($this->attempts() < $this->tries && $this->job !== null && $this->job->getConnectionName() !== 'sync') {
                throw $e;
            }
            WebhookIngestor::finish($event, WebhookEvent::FAILED, $e->errorCode);
        } catch (Throwable $e) {
            report($e);
            WebhookIngestor::finish($event, WebhookEvent::FAILED, 'error');
        }
    }

    public function attempts(): int
    {
        return $this->job?->attempts() ?? 1;
    }
}
