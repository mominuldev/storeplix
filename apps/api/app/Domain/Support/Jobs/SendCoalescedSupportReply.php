<?php

declare(strict_types=1);

namespace App\Domain\Support\Jobs;

use App\Domain\Support\SupportNotifier;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\Mail;

/**
 * PHASE-8-9C §10 coalescing: staff replies after the first one in a 5-minute window are summed into this one delayed
 * mail. Reads only the cached, already-rendered strings (no tenant data).
 */
class SendCoalescedSupportReply implements ShouldQueue
{
    use Queueable;

    public function __construct(public readonly string $ticketId)
    {
        $this->onQueue('notifications');
    }

    public function handle(): void
    {
        $pending = Cache::pull('support:reply-mail-pending:'.$this->ticketId);
        Cache::forget('support:reply-mail-job:'.$this->ticketId);
        if (! is_array($pending) || (int) ($pending['count'] ?? 0) < 1 || ! is_string($pending['to'] ?? null) || ! is_array($pending['args'] ?? null)) {
            return;
        }
        /** @var array{0: string, 1: string, 2: string, 3: string, 4: string} $args */
        $args = array_values($pending['args']);
        Mail::to($pending['to'])->queue(SupportNotifier::coalesced($pending['to'], $args, (int) $pending['count']));
    }
}
