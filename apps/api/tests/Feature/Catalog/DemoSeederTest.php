<?php

namespace Tests\Feature\Catalog;

use App\Domain\Catalog\Models\Category;
use App\Domain\Catalog\Models\Product;
use App\Domain\Coupons\Models\Coupon;
use App\Domain\Couriers\Models\CourierAccount;
use App\Domain\Customers\Models\Customer;
use App\Domain\Media\Models\Media;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\Models\Shipment;
use App\Domain\Payments\Models\PaymentGatewayAccount;
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
        $this->assertSame(9, Customer::withoutTenancy()->count()); // 5 demo customers + 2 from DemoPaymentsSeeder (5b-2) + 2 from DemoCouriersSeeder (5b-3)
        $this->assertSame(8, Media::withoutTenancy()->where('purpose', 'product_image')->where('status', Media::READY)->count());
        // Phase 5a
        $this->assertSame(2, ShippingZone::withoutTenancy()->count());
        $this->assertSame(1, PickupLocation::withoutTenancy()->count());
        $this->assertSame(['FREEDELIVERY', 'WELCOME10'], Coupon::withoutTenancy()->orderBy('code')->pluck('code')->all());
        $this->assertSame(
            ['cancelled', 'confirmed', 'confirmed', 'confirmed', 'delivered', 'pending', 'ready_to_ship', 'ready_to_ship', 'shipped', 'shipped'],
            Order::withoutTenancy()->orderBy('status')->pluck('status')->all(),
        );
        // Phase 5b-2 (DemoPaymentsSeeder): one bKash-paid order + one delivery-charge link paid, one fake bKash account.
        $this->assertSame(['paid', 'partially_paid'], Order::withoutTenancy()->whereJsonContains('tags', 'demo-online')->orderBy('sequence')->pluck('payment_status')->all());
        $this->assertSame(1, PaymentGatewayAccount::withoutTenancy()->where('enabled', true)->count());
        $this->assertSame(['DE-1001', 'DE-1010'], [Order::withoutTenancy()->min('number'), Order::withoutTenancy()->max('number')]);
        // Phase 5b-3 (DemoCouriersSeeder): a connected Steadfast account and 2 courier shipments (booked, in_transit).
        $this->assertSame(1, CourierAccount::withoutTenancy()->where('status', 'connected')->count());
        $this->assertSame(['booked', 'in_transit'], Shipment::withoutTenancy()->where('provider', 'steadfast')->orderBy('status')->pluck('status')->all());
        // Phase 5b-5: one approved return on the delivered order
        $this->assertSame([['RT-0001', 'approved']], ReturnRequest::withoutTenancy()->get(['number', 'status'])->map(fn ($r) => [$r->number, $r->status])->all());
        $this->assertSame('requested', Order::withoutTenancy()->where('status', 'delivered')->value('return_status'));
    }
}
