<?php

declare(strict_types=1);

namespace App\Domain\Domains\Listeners;

use App\Domain\Domains\DomainFailureCode;
use App\Domain\Domains\DomainNotifier;
use App\Domain\Domains\Events\DomainStatusChanged;
use App\Domain\Domains\Mail\DomainStatusMail;
use App\Domain\Stores\Models\StoreDomain;

/** P6-19: owner emails for live / verification failed / expired. (Fallback, DNS-missing and released are sent where they happen.) */
final class SendDomainStatusEmail
{
    public function __construct(private readonly DomainNotifier $notifier) {}

    public function handle(DomainStatusChanged $event): void
    {
        $kind = match ($event->to) {
            StoreDomain::STATUS_ACTIVE => DomainStatusMail::LIVE,
            StoreDomain::STATUS_VERIFICATION_FAILED => DomainStatusMail::FAILED,
            StoreDomain::STATUS_EXPIRED => DomainStatusMail::EXPIRED,
            default => null,
        };
        if ($kind === null || ($kind === DomainStatusMail::LIVE && $event->from === StoreDomain::STATUS_SUSPENDED)) {
            return;
        }
        $detail = $event->failureCode !== null ? DomainFailureCode::tryFrom($event->failureCode)?->message() : null;
        $this->notifier->mail($event->tenantId, $event->storeId, $kind, $event->hostname, $detail);
    }
}
