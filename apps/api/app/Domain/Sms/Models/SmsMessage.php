<?php

namespace App\Domain\Sms\Models;

use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;

/**
 * Outbound SMS log. tenant_id is nullable (auth OTPs are account-level), so this is a
 * platform model; never stores OTP plaintext (template name only).
 *
 * @property string $id
 * @property string|null $tenant_id
 * @property string $to
 * @property string $purpose
 * @property string $template
 * @property string|null $provider_message_id
 * @property string $status queued|sent|failed
 * @property string|null $error
 */
class SmsMessage extends Model
{
    use HasUlids;

    protected $fillable = ['tenant_id', 'to', 'purpose', 'template', 'provider_message_id', 'status', 'error'];
}
