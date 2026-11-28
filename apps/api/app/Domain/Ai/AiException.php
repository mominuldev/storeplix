<?php

declare(strict_types=1);

namespace App\Domain\Ai;

use RuntimeException;

/**
 * A provider call that produced no usable result. `errorCode` is an AiErrorCode (@storeplix/types): ai_refused,
 * ai_unavailable, ai_timeout, ai_output_invalid, image_unsupported, provider_error. The message is safe to log (codes and
 * HTTP statuses only, never the API key, the prompt or the model's text).
 */
final class AiException extends RuntimeException
{
    public const REFUSED = 'ai_refused';

    public const UNAVAILABLE = 'ai_unavailable';

    public const TIMEOUT = 'ai_timeout';

    public const OUTPUT_INVALID = 'ai_output_invalid';

    public const IMAGE_UNSUPPORTED = 'image_unsupported';

    public const PROVIDER_ERROR = 'provider_error';

    public function __construct(public readonly string $errorCode, string $message = '')
    {
        parent::__construct($message !== '' ? $message : $errorCode);
    }
}
