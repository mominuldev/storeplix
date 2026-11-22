<?php

// Fixed customer SMS templates (PHASE-5-CONTRACT §8), English. "Tk" because ৳ is not in GSM-7.
return [
    'order_placed' => '{shop}: Order {number} received. Total Tk {total}, pay on delivery. Track: {track_url}',
    'order_confirmed' => '{shop}: Order {number} is confirmed.',
    'order_shipped' => '{shop}: Order {number} is on its way with {carrier}. Keep Tk {due} ready. Track: {track_url}',
    'order_cancelled' => '{shop}: Order {number} has been cancelled.',
    'order_updated' => '{shop}: Order {number} was updated. New total Tk {total}, pay Tk {due} on delivery.',
];
