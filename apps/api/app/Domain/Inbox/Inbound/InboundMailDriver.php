<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Inbound;

use Illuminate\Http\Request;

/** Inbound mail provider (PHASE-8-8E P88E-15, Q299 open): `mailgun` and `fake` (never in production). */
interface InboundMailDriver
{
    /** Signature + timestamp (±15 min) + replay (token unseen for 1 h). False → 401, nothing stored. */
    public function verify(Request $request): bool;

    public function parse(Request $request): InboundEmail;
}
