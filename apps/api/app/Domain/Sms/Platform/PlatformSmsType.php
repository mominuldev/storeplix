<?php

declare(strict_types=1);

namespace App\Domain\Sms\Platform;

use App\Domain\Sms\SmsRoute;

/**
 * PHASE-8-9B §6.1 (P89B-11 – P89B-13): the nine platform SMS types, their group (= route), `sms_messages.purpose`, merge
 * fields, required fields and whether they are locked (account codes: always on, fixed English text).
 */
enum PlatformSmsType: string
{
    case Welcome = 'welcome';
    case PhoneVerification = 'phone_verification';
    case InvoiceIssued = 'invoice_issued';
    case PaymentReceived = 'payment_received';
    case PaymentDue = 'payment_due';
    case PlanExpiring = 'plan_expiring';
    case SignInCode = 'sign_in_code';
    case PasswordResetCode = 'password_reset_code';
    case Broadcast = 'broadcast';

    public const TEST_PURPOSE = 'platform_test';

    /** Every platform purpose (§3.2) incl. the test row. */
    public static function purposes(): array
    {
        return [...array_map(fn (self $t) => $t->purpose(), self::cases()), self::TEST_PURPOSE];
    }

    public static function fromPurpose(string $purpose): ?self
    {
        foreach (self::cases() as $t) {
            if ($t->purpose() === $purpose) {
                return $t;
            }
        }

        return null;
    }

    public function group(): string
    {
        return match ($this) {
            self::Welcome, self::PhoneVerification => 'registration',
            self::InvoiceIssued, self::PaymentReceived, self::PaymentDue, self::PlanExpiring => 'billing',
            self::SignInCode, self::PasswordResetCode => 'security',
            self::Broadcast => 'promotional',
        };
    }

    public function route(): SmsRoute
    {
        return SmsRoute::from($this->group());
    }

    public function purpose(): string
    {
        return match ($this) {
            self::PhoneVerification => 'otp_verify_phone',
            self::SignInCode => 'otp_login',
            self::PasswordResetCode => 'otp_reset_password',
            default => 'platform_'.$this->value,
        };
    }

    public function locked(): bool
    {
        return in_array($this, [self::PhoneVerification, self::SignInCode, self::PasswordResetCode], true);
    }

    /** Has bn/en templates staff can edit (not the codes, not broadcasts). */
    public function editable(): bool
    {
        return ! $this->locked() && $this !== self::Broadcast;
    }

    public function label(): string
    {
        return match ($this) {
            self::Welcome => 'Welcome',
            self::PhoneVerification => 'Phone verification code',
            self::InvoiceIssued => 'Invoice issued',
            self::PaymentReceived => 'Payment received',
            self::PaymentDue => 'Payment due or failed',
            self::PlanExpiring => 'Plan expiring',
            self::SignInCode => 'Sign-in code',
            self::PasswordResetCode => 'Password reset code',
            self::Broadcast => 'Broadcasts',
        };
    }

    public function trigger(): string
    {
        return match ($this) {
            self::Welcome => 'A new merchant verifies their phone',
            self::PhoneVerification => 'A merchant verifies a phone number',
            self::InvoiceIssued => 'A renewal invoice is issued',
            self::PaymentReceived => 'A payment is confirmed',
            self::PaymentDue => 'An invoice is due soon or a payment failed',
            self::PlanExpiring => 'A trial or grace period is about to end',
            self::SignInCode => 'A merchant signs in with a phone code',
            self::PasswordResetCode => 'A merchant resets their password by phone',
            self::Broadcast => 'Staff send a broadcast',
        };
    }

    /** @return list<string> */
    public function mergeFields(): array
    {
        return match ($this) {
            self::Welcome => ['merchant_name', 'store_name', 'link'],
            self::PhoneVerification, self::SignInCode, self::PasswordResetCode => ['otp'],
            self::InvoiceIssued, self::PaymentDue => ['merchant_name', 'store_name', 'invoice_no', 'amount', 'due_date', 'plan', 'link'],
            self::PaymentReceived => ['merchant_name', 'store_name', 'invoice_no', 'amount', 'plan'],
            self::PlanExpiring => ['merchant_name', 'store_name', 'plan', 'due_date', 'link'],
            self::Broadcast => ['merchant_name', 'store_name', 'plan', 'link'],
        };
    }

    /** @return list<string> */
    public function requiredFields(): array
    {
        return match ($this) {
            self::InvoiceIssued, self::PaymentDue => ['invoice_no', 'link'],
            self::PaymentReceived => ['invoice_no'],
            self::PlanExpiring => ['link'],
            self::PhoneVerification, self::SignInCode, self::PasswordResetCode => ['otp'],
            default => [],
        };
    }

    /** P89B-13: promotional SMS use the promotional mask; everything else the default sender. */
    public function sender(): string
    {
        return $this === self::Broadcast ? 'promotional' : 'default';
    }

    /** Retry window in minutes (P89B-10: codes 5, everything else 30). */
    public function retryWindowMinutes(): int
    {
        return $this->locked() ? (int) config('sms.platform.code_retry_window_minutes', 5) : (int) config('sms.platform.retry_window_minutes', 30);
    }
}
