<?php

namespace Database\Seeders;

use App\Domain\Catalog\CategoryService;
use App\Domain\Catalog\Models\Category;
use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\ProductPayloadValidator;
use App\Domain\Catalog\ProductService;
use App\Domain\Customers\CustomerService;
use App\Domain\Customers\Models\Customer;
use App\Domain\Identity\Models\User;
use App\Domain\Media\Jobs\ProcessMedia;
use App\Domain\Media\Models\Media;
use App\Domain\Media\TenantStorage;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Revalidation\StorefrontRevalidation;
use App\Domain\Stores\Revalidation\StorefrontRevalidationObserver;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Database\Seeder;
use Illuminate\Support\Str;

/**
 * Phase 4 demo catalog for store "demo": 3 categories, 8 active products (theme demo images as media, run through the
 * normal Media pipeline), 5 customers. Idempotent: rows are matched by slug / phone / media checksum.
 */
class DemoCatalogSeeder extends Seeder
{
    private const CATEGORIES = [
        'clothing' => 'Clothing',
        'toys-gifts' => 'Toys & Gifts',
        'feeding-bath' => 'Feeding & Bath',
    ];

    /** slug => [name, category, image, price ৳, compare-at ৳|null, cost ৳, sizes|null, stock] */
    private const PRODUCTS = [
        'cotton-summer-set' => ['Cotton Summer Set', 'clothing', 'summer-wear', 1250, 1500, 700, ['1-2Y', '2-3Y', '3-4Y'], 12],
        'knit-cardigan' => ['Hand-knit Cardigan', 'clothing', 'cardigan', 1890, null, 1100, ['1-2Y', '2-3Y'], 8],
        'quilted-puffer-jacket' => ['Quilted Puffer Jacket', 'clothing', 'puffer', 2450, 2990, 1500, ['2-3Y', '3-4Y', '4-5Y'], 4],
        'plush-elephant' => ['Plush Elephant', 'toys-gifts', 'elephant', 850, null, 420, null, 25],
        'newborn-gift-set' => ['Newborn Gift Set', 'toys-gifts', 'gift-set', 3200, 3600, 2000, null, 6],
        'bamboo-meal-set' => ['Bamboo Meal Set', 'feeding-bath', 'meal-set', 990, null, 520, null, 18],
        'organic-baby-food-pack' => ['Organic Baby Food Pack', 'feeding-bath', 'baby-food', 650, 750, 380, null, 3],
        'gentle-bath-set' => ['Gentle Bath Set', 'feeding-bath', 'bath-set', 1150, null, 600, null, 0],
    ];

    private const CUSTOMERS = [
        ['Farhana Rahman', '01556120987', 'farhana@example.com', 'Narayanganj', 'instagram', ['repeat buyer']],
        ['Rakib Hasan', '01712345678', null, 'Dhaka', 'facebook', []],
        ['Nusrat Jahan', '01811223344', 'nusrat@example.com', 'Chattogram', 'whatsapp', ['vip']],
        ['Tanvir Ahmed', '01911556677', null, 'Sylhet', 'phone', []],
        ['Sadia Islam', '01611998877', 'sadia@example.com', 'Rajshahi', 'website', []],
    ];

    public function run(TenantContext $context, ProductService $products, CategoryService $categories, CustomerService $customers, TenantStorage $storage): void
    {
        $store = Store::withoutTenancy()->where('slug', 'demo')->first();
        if ($store === null) {
            return;
        }
        $user = User::query()->where('email', 'demo@storeplix.test')->first();

        $context->run($store->tenant_id, function () use ($store, $user, $products, $categories, $customers, $storage) {
            StorefrontRevalidation::muted(function () use ($store, $user, $products, $categories, $customers, $storage) {
                $categoryIds = [];
                foreach (self::CATEGORIES as $slug => $name) {
                    $categoryIds[$slug] = Category::query()->where('store_id', $store->id)->where('slug', $slug)->value('id')
                        ?? $categories->create($store, ['name' => $name, 'slug' => $slug], $user)->id;
                }

                foreach (self::PRODUCTS as $slug => [$name, $category, $image, $price, $compare, $cost, $sizes, $stock]) {
                    if (Product::query()->where('store_id', $store->id)->where('slug', $slug)->exists()) {
                        continue;
                    }
                    $mediaId = $this->media($storage, $image, $user);
                    $variant = fn (array $values, int $i) => [
                        'option_values' => $values, 'sku' => strtoupper(Str::substr($slug, 0, 8)).($values ? '-'.$values[0] : ''),
                        'price_amount' => $price * 100, 'compare_at_amount' => $compare ? $compare * 100 : null,
                        'cost_amount' => $cost * 100, 'initial_on_hand' => $sizes ? max(0, $stock - $i * 3) : $stock,
                    ];
                    $input = [
                        'name' => $name, 'slug' => $slug, 'status' => 'active', 'category_ids' => [$categoryIds[$category]],
                        'description' => ['type' => 'doc', 'content' => [['type' => 'paragraph', 'content' => [['type' => 'text', 'text' => "{$name} from the Storeplix demo shop."]]]]],
                        'images' => [['media_id' => $mediaId, 'alt' => $name]],
                        'options' => $sizes ? [['name' => 'Age', 'values' => $sizes]] : [],
                        'variants' => $sizes ? array_map(fn ($s, $i) => $variant([$s], $i), $sizes, array_keys($sizes)) : [$variant([], 0)],
                        'tags' => ['demo'],
                    ];
                    $products->create($store, ProductPayloadValidator::normalise($store, null, $input, true), $user, ['audit' => false]);
                }

                foreach (self::CUSTOMERS as [$name, $phone, $email, $district, $channel, $tags]) {
                    if (Customer::query()->where('store_id', $store->id)->where('phone', '88'.$phone)->exists()) {
                        continue;
                    }
                    $customers->create($store, ['name' => $name, 'phone' => '88'.$phone, 'email' => $email, 'district' => $district, 'channel' => $channel, 'tags' => $tags], $user);
                }
            });
            app(StorefrontRevalidationObserver::class)->dispatch($store->tenant_id, $store->id);
        });
    }

    /** Reuses a ready media row with the same checksum; otherwise stores + processes the demo image now. */
    private function media(TenantStorage $storage, string $image, ?User $user): string
    {
        $path = database_path("seeders/demo-images/{$image}.jpg");
        $checksum = hash_file('sha256', $path);
        $existing = Media::query()->where('checksum', $checksum)->where('purpose', 'product_image')->where('status', '!=', Media::FAILED)->value('id');
        if ($existing !== null) {
            return $existing;
        }
        [$width, $height] = getimagesize($path);
        $id = strtolower((string) Str::ulid());
        $disk = $storage->diskName();
        $objectPath = $storage->path($id, 'original.jpg');
        $storage->disk($disk)->put($objectPath, (string) file_get_contents($path));
        $media = new Media([
            'purpose' => 'product_image', 'disk' => $disk, 'path' => $objectPath, 'mime' => 'image/jpeg',
            'size_bytes' => filesize($path), 'width' => $width, 'height' => $height, 'checksum' => $checksum,
            'alt' => null, 'uploaded_by' => $user?->id,
        ]);
        $media->id = $id;
        $media->save();
        ProcessMedia::dispatchSync($id);

        return $id;
    }
}
