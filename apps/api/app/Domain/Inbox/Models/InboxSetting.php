<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * Per-store Inbox channels (PHASE-8-8E §4, P88E-20). Absent row = every channel off; created lazily by
 * InboxSettingsService. Nothing mass-assignable.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property bool $web_chat_enabled
 * @property bool $order_messages_enabled
 * @property bool $email_enabled
 * @property string|null $email_key
 * @property Carbon|null $email_key_rotated_at
 * @property string $widget_reply_time
 * @property string|null $widget_hours
 * @property string|null $widget_greeting
 * @property int $revision
 * @property string|null $updated_by
 */
class InboxSetting extends Model
{
    use BelongsToTenant, HasUlids;

    public const REPLY_TIMES = ['minutes', 'hour', 'day'];

    protected $table = 'inbox_settings';

    protected $fillable = [];

    protected $attributes = [
        'web_chat_enabled' => false, 'order_messages_enabled' => false, 'email_enabled' => false,
        'widget_reply_time' => 'minutes', 'revision' => 1,
    ];

    protected function casts(): array
    {
        return [
            'web_chat_enabled' => 'boolean', 'order_messages_enabled' => 'boolean', 'email_enabled' => 'boolean',
            'email_key_rotated_at' => 'datetime', 'revision' => 'integer',
        ];
    }
}
