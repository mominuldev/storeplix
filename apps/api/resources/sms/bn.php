<?php

// Fixed customer SMS templates (PHASE-5-CONTRACT §8), Bangla (default). Variables are sanitised and truncated by
// SmsTemplates before rendering; amounts use "টাকা" because ৳ is not in GSM-7. Keep each ≤ 201 UCS-2 characters
// (3 segments) with a 40-character shop name (unit-tested).
return [
    'order_placed' => 'প্রিয় {first_name}, {shop} এ আপনার অর্ডার {number} পেয়েছি। মোট {total} টাকা, ডেলিভারির সময় পরিশোধ করবেন। ট্র্যাক: {track_url}',
    'order_confirmed' => '{shop}: আপনার অর্ডার {number} কনফার্ম হয়েছে।',
    'order_shipped' => '{shop}: অর্ডার {number} {carrier} এর মাধ্যমে পাঠানো হয়েছে। {due} টাকা প্রস্তুত রাখুন। ট্র্যাক: {track_url}',
    'order_cancelled' => '{shop}: অর্ডার {number} বাতিল করা হয়েছে।',
];
