<?php

namespace Tests\Feature\Catalog;

use App\Domain\Catalog\Models\Category;
use App\Domain\Catalog\Models\Product;
use App\Domain\Customers\Models\Customer;
use App\Domain\Media\Models\Media;
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
    }
}
