<?php

namespace App\Domain\Shared\Http;

use Symfony\Component\HttpKernel\Exception\HttpException;

/**
 * HTTP exception carrying a stable machine-readable error code for the API envelope:
 * { "error": { "code", "message", "details"? } }.
 */
class ApiException extends HttpException
{
    /**
     * @param  array<string, array<int, string>>|null  $details
     */
    public function __construct(
        int $status,
        public readonly string $errorCode,
        string $message,
        public readonly ?array $details = null,
    ) {
        parent::__construct($status, $message);
    }
}
