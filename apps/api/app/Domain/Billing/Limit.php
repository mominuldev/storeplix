<?php

namespace App\Domain\Billing;

/** LimitKey in @storeplix/types. */
enum Limit: string
{
    case OrdersPerMonth = 'orders_per_month';
    case StaffSeats = 'staff_seats';
    case Products = 'products';
    case CourierConnections = 'courier_connections';
    case SmsPerMonth = 'sms_per_month';
    case CustomDomains = 'custom_domains';
}
