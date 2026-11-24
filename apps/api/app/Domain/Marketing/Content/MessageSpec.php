<?php

declare(strict_types=1);

namespace App\Domain\Marketing\Content;

use App\Domain\Catalog\Models\Product;
use App\Domain\Coupons\Models\Coupon;
use App\Domain\Marketing\Models\Campaign;

/**
 * The message parts of a campaign (or of an unsaved draft, for estimates) the renderer needs. PHASE-8-6 §8 adds the
 * automation merge values `{order_no}` / `{cart_link}` and the product-name cap used by the 3-part SMS fallback.
 */
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
        public readonly ?string $orderNo = null,
        public readonly ?string $cartLink = null,
        public readonly int $productNameMax = 60,
    ) {}

    /** A copy with the product rendered as its name only (no link), capped at `$max` characters. */
    public function withoutProductLink(int $max = 60): self
    {
        return new self($this->channel, $this->language, $this->body, $this->subject, $this->couponCode, $this->productName, null, $this->orderNo, $this->cartLink, $max);
    }

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
