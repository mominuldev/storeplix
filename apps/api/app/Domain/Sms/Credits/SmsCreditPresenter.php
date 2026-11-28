<?php

declare(strict_types=1);

namespace App\Domain\Sms\Credits;

use App\Domain\Billing\Gateways\PlatformCredentials;
use App\Domain\Billing\Http\Resources\BillingPresenter;
use App\Domain\Billing\Models\BillingInvoice;
use App\Domain\Sms\Models\SmsCreditAccount;
use App\Domain\Sms\Models\SmsCreditLedgerEntry;

/** PHASE-8-9A §5: SmsCreditAccount, SmsCreditLedgerEntry, AdminSmsCredits (openapi 1.23.0). Inside the tenant context. */
final class SmsCreditPresenter
{
    /** @return array<string, mixed> SmsCreditAccount */
    public static function account(SmsCreditService $credits, ?SmsCreditAccount $account = null): array
    {
        $account ??= $credits->find();
        $open = BillingInvoice::query()->where('kind', BillingInvoice::SMS_CREDITS)->where('status', BillingInvoice::OPEN)->first();

        return $credits->summary($account) + [
            'packs' => SmsCreditPurchaseService::packs(),
            'providers' => PlatformCredentials::providers(),
            'open_invoice' => $open !== null ? BillingPresenter::invoiceSummary($open) : null,
            'last_purchase_at' => $account?->last_purchase_at?->toIso8601ZuluString(),
        ];
    }

    /** @return array<string, mixed> SmsCreditLedgerEntry */
    public static function entry(SmsCreditLedgerEntry $row): array
    {
        $invoice = $row->billing_invoice_id !== null && $row->relationLoaded('invoice') ? $row->invoice : null;

        return [
            'id' => $row->id,
            'type' => $row->type,
            'credits' => (int) $row->credits,
            'balance_after' => (int) $row->balance_after,
            'created_at' => $row->created_at->toIso8601ZuluString(),
            'invoice' => $row->type === SmsCreditLedgerEntry::PURCHASE && $invoice !== null ? ['id' => $invoice->id, 'number' => $invoice->number] : null,
            'sms_message_id' => $row->sms_message_id,
            'reason' => $row->type === SmsCreditLedgerEntry::ADMIN_ADJUST ? $row->reason : null,
        ];
    }

    /** @return array<string, mixed> AdminSmsCredits */
    public static function admin(SmsCreditService $credits, int $usedThisMonth): array
    {
        $account = $credits->find();
        $summary = $credits->summary($account);

        return [
            'balance' => $summary['balance'],
            'status' => $summary['status'],
            'low_credit_threshold' => $summary['low_credit_threshold'],
            'used_this_month' => $usedThisMonth,
            'purchased_total' => (int) ($account?->purchased_total ?? 0),
            'last_purchase_at' => $account?->last_purchase_at?->toIso8601ZuluString(),
        ];
    }
}
