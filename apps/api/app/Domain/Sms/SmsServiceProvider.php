<?php

namespace App\Domain\Sms;

use App\Domain\Sms\Drivers\FakeSmsGateway;
use App\Domain\Sms\Drivers\LogSmsGateway;
use App\Domain\Sms\Drivers\RevesmsGateway;
use Illuminate\Support\ServiceProvider;
use InvalidArgumentException;

class SmsServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->singleton(SmsGateway::class, fn ($app) => match ($app['config']->get('sms.driver')) {
            'revesms' => new RevesmsGateway($app['config']->get('sms.revesms')),
            'log' => new LogSmsGateway,
            'fake' => new FakeSmsGateway,
            default => throw new InvalidArgumentException('Unknown SMS_DRIVER.'),
        });
    }
}
