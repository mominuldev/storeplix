<?php

declare(strict_types=1);

namespace App\Domain\Domains\Providers;

use RuntimeException;

/** A provider call failed. `duplicate` = the hostname already exists at the provider (create is then adopt). */
final class ProviderException extends RuntimeException
{
    public const ERROR = 'provider_error';

    public const DUPLICATE = 'duplicate';

    public const AUTH = 'auth';

    public function __construct(public readonly string $kind, string $message = 'Provider call failed.', public readonly ?int $status = null)
    {
        parent::__construct($message);
    }
}
