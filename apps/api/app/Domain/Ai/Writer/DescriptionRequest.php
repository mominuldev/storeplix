<?php

declare(strict_types=1);

namespace App\Domain\Ai\Writer;

/**
 * Everything a description driver may send to the provider (P89D-38, S344): product name, category, option names and
 * values, the merchant's key points, tone / length / language, the number of variants and optionally the main product
 * image (re-encoded JPEG, base64). Never customer, order, price, cost or staff data — there is no field for it.
 */
final readonly class DescriptionRequest
{
    /**
     * @param  list<array{name: string, values: list<string>}>  $options
     * @param  list<string>  $keyPoints
     * @param  array{media_type: string, data: string}|null  $image
     */
    public function __construct(
        public string $name,
        public ?string $category,
        public array $options,
        public array $keyPoints,
        public string $language,
        public string $tone,
        public string $length,
        public int $variants,
        public ?array $image = null,
    ) {}

    /** The product data block (merchant text = data, P89D-38). @return array<string, mixed> */
    public function productData(): array
    {
        return [
            'name' => $this->name,
            'category' => $this->category,
            'options' => $this->options,
            'key_points' => $this->keyPoints,
        ];
    }
}
