<?php

declare(strict_types=1);

namespace App\Domain\Ai\Writer;

/** A driver's raw answer: the decoded `variants` (untrusted; DescriptionOutput builds the presented form), model, usage. */
final readonly class WriterResult
{
    /**
     * @param  list<mixed>  $variants
     * @param  array<string, int>  $usage
     */
    public function __construct(
        public array $variants,
        public ?string $model,
        public array $usage = [],
    ) {}
}
