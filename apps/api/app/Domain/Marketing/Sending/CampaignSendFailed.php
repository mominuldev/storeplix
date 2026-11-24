<?php

declare(strict_types=1);

namespace App\Domain\Marketing\Sending;

use RuntimeException;

/** A provider refused or failed one campaign message; `$errorCode` ∈ provider_error | invalid_address. */
final class CampaignSendFailed extends RuntimeException
{
    public function __construct(public readonly string $errorCode, string $message = '')
    {
        parent::__construct($message);
    }
}
