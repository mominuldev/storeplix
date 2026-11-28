<?php

// PHASE-8-9B §6.2: default Bangla texts of the editable platform SMS types (merge fields in braces; {link} is server-made).
// Locked code texts are English for both languages (= OtpService::TEXT).
return [
    'welcome' => 'Store Plix-এ স্বাগতম, {merchant_name}! {store_name} তৈরি। পণ্য যোগ করে বিক্রি শুরু করুন: {link}',
    'invoice_issued' => 'Store Plix: {plan} প্ল্যানের ইনভয়েস {invoice_no}, {amount} টাকা, শেষ তারিখ {due_date}। পরিশোধ: {link}',
    'payment_received' => 'Store Plix: ইনভয়েস {invoice_no}-এর {amount} টাকা পেয়েছি। ধন্যবাদ!',
    'payment_due' => 'Store Plix: ইনভয়েস {invoice_no} ({amount} টাকা) পরিশোধ হয়নি, শেষ তারিখ {due_date}। পরিশোধ: {link}',
    'plan_expiring' => 'Store Plix: {store_name}-এর {plan} প্ল্যান {due_date} শেষ হবে। চালু রাখতে: {link}',
    'phone_verification' => 'Your Store Plix code is {otp}. Valid for 5 minutes. Do not share it.',
    'sign_in_code' => 'Your Store Plix code is {otp}. Valid for 5 minutes. Do not share it.',
    'password_reset_code' => 'Your Store Plix code is {otp}. Valid for 5 minutes. Do not share it.',
];
