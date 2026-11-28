<?php

// PHASE-8-9B §6.2: default English texts of the editable platform SMS types (merge fields in braces; {link} is server-made).
return [
    'welcome' => 'Welcome to Store Plix, {merchant_name}! {store_name} is ready. Add products and start selling: {link}',
    'invoice_issued' => 'Store Plix: Invoice {invoice_no} for Tk {amount} ({plan}) is due {due_date}. Pay: {link}',
    'payment_received' => 'Store Plix: Payment of Tk {amount} for invoice {invoice_no} received. Thank you!',
    'payment_due' => 'Store Plix: Invoice {invoice_no} (Tk {amount}) is unpaid, due {due_date}. Pay now to keep {plan}: {link}',
    'plan_expiring' => 'Store Plix: Your {plan} plan for {store_name} ends {due_date}. Keep it: {link}',
    'phone_verification' => 'Your Store Plix code is {otp}. Valid for 5 minutes. Do not share it.',
    'sign_in_code' => 'Your Store Plix code is {otp}. Valid for 5 minutes. Do not share it.',
    'password_reset_code' => 'Your Store Plix code is {otp}. Valid for 5 minutes. Do not share it.',
];
