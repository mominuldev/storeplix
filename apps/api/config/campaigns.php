<?php

declare(strict_types=1);

/*
 * Marketing campaigns, SMS + email (PHASE-8-5-CONTRACT; ADR 0019; SECURITY T35).
 *
 * SMS go through the existing SmsGateway (SMS_DRIVER); email through the `campaigns` mailer (CAMPAIGN_MAILER, mail.php).
 * CAMPAIGNS_DEV_SINK=true (non-production only, S125) records every rendered campaign/test message in a capped cache
 * list readable at GET /api/v1/dev/stores/{store}/message-sink. Production refuses to boot with the sink on, or with a
 * log/array campaign mailer while SMS_DRIVER=revesms (misconfig guard, §5.4).
 */
return [
    'dev_sink' => (bool) env('CAMPAIGNS_DEV_SINK', false),
    'dev_sink_size' => 200,

    'mailer' => 'campaigns',
    // Platform sending domain (Q146): From "{Store name}" <CAMPAIGN_MAIL_FROM>.
    'mail_from' => env('CAMPAIGN_MAIL_FROM', env('MAIL_FROM_ADDRESS', 'no-reply@storeplix.test')),

    'queue' => 'campaigns',

    // P85-12 throughput (per second).
    'sms_rate_per_second' => (int) env('CAMPAIGNS_SMS_RATE_PER_SECOND', 10),
    'platform_sms_rate_per_second' => (int) env('CAMPAIGNS_PLATFORM_SMS_RATE_PER_SECOND', 50),
    'email_rate_per_second' => (int) env('CAMPAIGNS_EMAIL_RATE_PER_SECOND', 20),

    // P85-12 / §5.1: recipients per SendCampaignBatch job; materialization insert chunk.
    'batch_size' => 100,
    // A batch stops claiming new recipients after this many seconds (job $timeout 240 < REDIS_QUEUE_RETRY_AFTER 360);
    // the rest stay `queued` and campaigns:dispatch-due resumes them (resume_after_minutes).
    'batch_budget_seconds' => 150,
    'insert_chunk' => 1000,

    // P85-15 quiet hours (store time): no start in [quiet_from, quiet_to); sending pauses.
    'quiet_from' => 21,
    'quiet_to' => 9,

    // P85-16 scheduling bounds.
    'schedule_min_lead_minutes' => 5,
    'schedule_max_days' => 90,

    // P85-27.
    'max_open_per_store' => 50,
    'max_sending_per_store' => 3,

    // P85-11: `sending` longer than this → `unknown` (never retried).
    'stuck_after_minutes' => 15,
    // A `sending` campaign whose queued recipients saw no activity for this long is re-kicked by dispatch-due
    // (after quiet hours, or a lost batch job). Duplicate batches are harmless (conditional UPDATE per recipient).
    'resume_after_minutes' => 2,

    // P85-21 attribution window.
    'attribution_days' => 7,

    // P85-26 test sends per user per hour.
    'test_sends_per_hour' => 5,

    // P85-28 recipient retention.
    'recipient_retention_months' => 13,

    // P85-18 / P85-19.
    'sms_max_parts' => 5,
    'sms_shop_prefix_max' => 20,
    'email_body_max' => 5000,
];
