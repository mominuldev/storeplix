<?php

declare(strict_types=1);

namespace App\Domain\Marketing\Content;

use App\Domain\Catalog\Models\Product;
use App\Domain\Coupons\Models\Coupon;
use App\Domain\Marketing\Models\Campaign;

/** The message parts of a campaign (or of an unsaved draft, for estimates) the renderer needs. */
final class MessageSpec
{
    public function __construct(
        public readonly string $channel,
        public readonly string $language,
        public readonly string $body,
        public readonly ?string $subject = null,
        public readonly ?string $couponCode = null,
        public readonly ?string $productName = null,
        public readonly ?string $productSlug = null,
    ) {}

    public static function of(Campaign $campaign): self
    {
        $campaign->loadMissing(['coupon', 'product']);

        return self::from($campaign->channel, $campaign->language, $campaign->body, $campaign->subject, $campaign->coupon, $campaign->product);
    }

    public static function from(string $channel, string $language, string $body, ?string $subject, ?Coupon $coupon, ?Product $product): self
    {
        return new self($channel, $language, $body, $subject, $coupon?->code, $product?->name, $product?->slug);
    }
}
