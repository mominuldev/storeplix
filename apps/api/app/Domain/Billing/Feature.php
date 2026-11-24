<?php

namespace App\Domain\Billing;

/** FeatureKey in @storeplix/types. */
enum Feature: string
{
    case CustomDomain = 'custom_domain';
    case AllCouriers = 'all_couriers';
    case BulkCourierBooking = 'bulk_courier_booking';
    case FakeOrderGuard = 'fake_order_guard';
    case SmsAutomation = 'sms_automation';
    case CustomRoles = 'custom_roles';
    case MultiWarehouse = 'multi_warehouse';
    case Pos = 'pos';
    case ProfitReports = 'profit_reports';
    case ApiWebhooks = 'api_webhooks';
    case Purchasing = 'purchasing'; // PHASE-8-8B §2.2 (Starter, Growth)
}
