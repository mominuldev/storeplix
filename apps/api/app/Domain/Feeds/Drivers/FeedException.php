<?php

declare(strict_types=1);

namespace App\Domain\Feeds\Drivers;

use RuntimeException;

/** A feed provider call failed. `code`: auth | rate_limited | unavailable | rejected | account; `step` for website claims. */
final class FeedException extends RuntimeException
{
    public const AUTH = 'auth';

    public const RATE_LIMITED = 'rate_limited';

    public const UNAVAILABLE = 'unavailable';

    public const REJECTED = 'rejected';

    public const ACCOUNT = 'account';

    public function __construct(public readonly string $reason, string $message = '', public readonly ?string $step = null)
    {
        parent::__construct($message !== '' ? $message : "Feed provider error: {$reason}");
    }
}
