<?php

// Fixed customer SMS templates (PHASE-5-CONTRACT §8), Bangla (default). Variables are sanitised and truncated by
// SmsTemplates before rendering; amounts use "টাকা" because ৳ is not in GSM-7. Keep each ≤ 201 UCS-2 characters
// (3 segments) with a 40-character shop name (unit-tested).
return [
    'order_placed' => 'প্রিয় {first_name}, {shop} এ আপনার অর্ডার {number} পেয়েছি। মোট {total} টাকা, ডেলিভারির সময় পরিশোধ করবেন। ট্র্যাক: {track_url}',
    'order_confirmed' => '{shop}: আপনার অর্ডার {number} কনফার্ম হয়েছে।',
    'order_shipped' => '{shop}: অর্ডার {number} {carrier} এর মাধ্যমে পাঠানো হয়েছে। {due} টাকা প্রস্তুত রাখুন। ট্র্যাক: {track_url}',
    'order_cancelled' => '{shop}: অর্ডার {number} বাতিল করা হয়েছে।',
    'payment_link' => '{shop}: অর্ডার {number} নিশ্চিত করতে {amount} টাকা পরিশোধ করুন: {url}',
    'order_updated' => '{shop}: আপনার অর্ডার {number} আপডেট হয়েছে। নতুন মোট {total} টাকা, ডেলিভারির সময় দিতে হবে {due} টাকা।',
    // PHASE-8-8 P88-13: shopper checkout code (vars: shop, code).
    'checkout_otp' => '{shop}: আপনার চেকআউট কোড {code}। কোডটি ৫ মিনিট বৈধ। কাউকে জানাবেন না।',
    // PHASE-8-8D P88D-12: till SMS receipt (vars: shop, number, total, method, footer); text only, no link.
    'pos_receipt' => '{shop}: ধন্যবাদ! রসিদ {number}, মোট {total} টাকা, পরিশোধ: {method}। {footer}',
    // PHASE-8-8E P88E-11/12: Inbox chat code (vars: shop, code) and "the shop replied" with a magic link (vars: shop, url).
    'inbox_verify' => '{shop}: আপনার কোড {code}। ১০ মিনিট কার্যকর।',
    'inbox_reply' => '{shop}: আপনার মেসেজের উত্তর দেওয়া হয়েছে। দেখুন: {url}',
];
