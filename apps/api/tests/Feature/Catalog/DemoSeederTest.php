<?php

namespace Tests\Feature\Catalog;

use App\Domain\Catalog\Models\Category;
use App\Domain\Catalog\Models\Product;
use App\Domain\Coupons\Models\Coupon;
use App\Domain\Customers\Models\Customer;
use App\Domain\Media\Models\Media;
use App\Domain\Orders\Models\Order;
use App\Domain\Returns\Models\ReturnRequest;
use App\Domain\Shipping\Models\PickupLocation;
use App\Domain\Shipping\Models\ShippingZone;
use Database\Seeders\DatabaseSeeder;
use Illuminate\Foundation\Testing\RefreshDatabase;
use Illuminate\Support\Facades\Storage;
use Tests\TestCase;

class DemoSeederTest extends TestCase
{
    use RefreshDatabase;

    public function test_demo_catalog_is_seeded_idempotently(): void
    {
        Storage::fake('public');
        $this->seed(DatabaseSeeder::class);
        $this->seed(DatabaseSeeder::class);

        $this->assertSame(3, Category::withoutTenancy()->count());
        $this->assertSame(8, Product::withoutTenancy()->where('status', 'active')->count());
        $this->assertSame(5, Customer::withoutTenancy()->count());
        $this->assertSame(8, Media::withoutTenancy()->where('purpose', 'product_image')->where('status', Media::READY)->count());
        // Phase 5a
        $this->assertSame(2, ShippingZone::withoutTenancy()->count());
        $this->assertSame(1, PickupLocation::withoutTenancy()->count());
        $this->assertSame(['FREEDELIVERY', 'WELCOME10'], Coupon::withoutTenancy()->orderBy('code')->pluck('code')->all());
        $this->assertSame(
            ['cancelled', 'confirmed', 'delivered', 'pending', 'ready_to_ship', 'shipped'],
            Order::withoutTenancy()->orderBy('status')->pluck('status')->all(),
        );
        $this->assertSame(['DE-1001', 'DE-1006'], [Order::withoutTenancy()->min('number'), Order::withoutTenancy()->max('number')]);
        // Phase 5b-5: one approved return on the delivered order
        $this->assertSame([['RT-0001', 'approved']], ReturnRequest::withoutTenancy()->get(['number', 'status'])->map(fn ($r) => [$r->number, $r->status])->all());
        $this->assertSame('requested', Order::withoutTenancy()->where('status', 'delivered')->value('return_status'));
    }
}
