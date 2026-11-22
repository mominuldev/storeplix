<?php

namespace App\Domain\Documents\Drivers;

use RuntimeException;

/** Renderer unavailable or refused the document. `code` becomes documents.error_code (no response body is kept). */
class DocumentRenderFailed extends RuntimeException
{
    public function __construct(public readonly string $errorCode, string $message)
    {
        parent::__construct($message);
    }
}
