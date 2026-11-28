<?php

declare(strict_types=1);

namespace App\Domain\Ai\Writer;

use App\Domain\Ai\AiException;

/** P89D-36: the product description driver (`anthropic` | `fake`, config `ai.driver`). */
interface ProductDescriptionWriter
{
    /** @throws AiException */
    public function write(DescriptionRequest $request): WriterResult;

    /** Provider name stored on the generation (`anthropic`, `fake`). */
    public function provider(): string;
}
