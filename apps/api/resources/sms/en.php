<?php

// Fixed customer SMS templates (PHASE-5-CONTRACT §8), English. "Tk" because ৳ is not in GSM-7.
return [
    'order_placed' => '{shop}: Order {number} received. Total Tk {total}, pay on delivery. Track: {track_url}',
    'order_confirmed' => '{shop}: Order {number} is confirmed.',
    'order_shipped' => '{shop}: Order {number} is on its way with {carrier}. Keep Tk {due} ready. Track: {track_url}',
    'order_cancelled' => '{shop}: Order {number} has been cancelled.',
    'payment_link' => '{shop}: Pay Tk {amount} to confirm order {number}: {url}',
    'order_updated' => '{shop}: Order {number} was updated. New total Tk {total}, pay Tk {due} on delivery.',
    // PHASE-8-8 P88-13: shopper checkout code (vars: shop, code).
    'checkout_otp' => '{shop}: Your checkout code is {code}. It is valid for 5 minutes. Do not share it.',
    // PHASE-8-8D P88D-12: till SMS receipt (vars: shop, number, total, method, footer); text only, no link.
    'pos_receipt' => '{shop}: Thank you! Receipt {number}, total Tk {total}, paid {method}. {footer}',
    // PHASE-8-8E P88E-11/12: Inbox chat code (vars: shop, code) and "the shop replied" with a magic link (vars: shop, url).
    'inbox_verify' => '{shop}: Your code is {code}. It expires in 10 minutes.',
    'inbox_reply' => '{shop}: We replied to your message. Read it here: {url}',
];
