<?php

use App\Domain\Billing\BillingServiceProvider;
use App\Domain\Catalog\CatalogServiceProvider;
use App\Domain\Orders\CommerceServiceProvider;
use App\Domain\Sms\SmsServiceProvider;
use App\Domain\Stores\StoresServiceProvider;
use App\Domain\Tenancy\TenancyServiceProvider;
use App\Providers\AppServiceProvider;

return [
    AppServiceProvider::class,
    TenancyServiceProvider::class,
    StoresServiceProvider::class,
    BillingServiceProvider::class,
    CatalogServiceProvider::class,
    CommerceServiceProvider::class,
    SmsServiceProvider::class,
];
