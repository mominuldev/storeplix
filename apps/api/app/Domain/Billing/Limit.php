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
    case CampaignSmsPerMonth = 'campaign_sms_per_month'; // PHASE-8-5 P85-13: SMS parts
    case CampaignEmailsPerMonth = 'campaign_emails_per_month'; // PHASE-8-5 P85-13
    case AiCreditsPerMonth = 'ai_credits_per_month'; // PHASE-8-9D P89D-33 (usage: part B AI credit ledger)
}
