<?php

declare(strict_types=1);

namespace App\Domain\Support\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * One immutable row of a ticket thread (PHASE-8-9C §3.1). `note` rows are staff-only: every merchant read filters
 * with `kind IN MERCHANT_KINDS` (S251).
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $ticket_id
 * @property string $kind
 * @property string|null $author_user_id
 * @property string|null $body
 * @property string|null $system_event
 * @property array<string, mixed>|null $system_meta
 * @property string|null $client_id
 * @property Carbon $created_at
 */
class SupportTicketMessage extends Model
{
    use BelongsToTenant, HasUlids;

    public const MERCHANT = 'merchant';

    public const STAFF = 'staff';

    public const NOTE = 'note';

    public const SYSTEM = 'system';

    /** S251: the only kinds any merchant route, mail or link may read. */
    public const MERCHANT_KINDS = [self::MERCHANT, self::STAFF, self::SYSTEM];

    /** System rows a merchant sees (P89C-16, §8.2). */
    public const MERCHANT_EVENTS = ['created', 'assigned', 'status_changed', 'reopened', 'auto_closed'];

    public const BODY_MAX = 5000;

    public const UPDATED_AT = null;

    protected $table = 'support_ticket_messages';

    protected $fillable = [];

    protected function casts(): array
    {
        return ['system_meta' => 'array'];
    }
}
