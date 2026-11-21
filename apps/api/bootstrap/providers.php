<?php

use App\Domain\Billing\BillingServiceProvider;
use App\Domain\Sms\SmsServiceProvider;
use App\Domain\Stores\StoresServiceProvider;
use App\Domain\Tenancy\TenancyServiceProvider;
use App\Providers\AppServiceProvider;

return [
    AppServiceProvider::class,
    TenancyServiceProvider::class,
    StoresServiceProvider::class,
    BillingServiceProvider::class,
    SmsServiceProvider::class,
];
