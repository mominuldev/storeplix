<?php

declare(strict_types=1);

namespace App\Domain\Sms\Jobs;

use App\Domain\Billing\BillingNotifier;
use App\Domain\Sms\Mail\SmsMail;
use App\Domain\Sms\Models\SmsCreditAccount;
use App\Domain\Tenancy\Queue\TenantAware;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Mail;

/**
 * PHASE-8-9A §5.6 (P89A-12, S219): one low-credit email per crossing. The conditional UPDATE (`low_alert_sent_at IS
 * NULL`) decides: only the job that changes the row emails the owner; re-armed on purchase / refund / grant / threshold
 * change when the balance is back at or above the threshold.
 */
class SendLowSmsCreditAlert implements ShouldQueue
{
    use Queueable, TenantAware;

    public int $tries = 1;

    public function handle(TenantContext $context): void
    {
        $tenantId = $context->requireId();
        $account = SmsCreditAccount::query()->where('tenant_id', $tenantId)->first();
        if ($account === null || $account->low_credit_threshold === null || $account->balance >= $account->low_credit_threshold) {
            return;
        }
        $claimed = DB::table('sms_credit_accounts')->where('tenant_id', $tenantId)->whereNull('low_alert_sent_at')
            ->update(['low_alert_sent_at' => now(), 'updated_at' => now()]);
        if ($claimed !== 1) {
            return;
        }
        $owner = BillingNotifier::ownerUser();
        if ($owner?->email !== null) {
            Mail::to($owner->email)->send(new SmsMail(SmsMail::LOW_CREDITS, BillingNotifier::shopName(), ['balance' => number_format($account->balance)]));
        }
    }
}
