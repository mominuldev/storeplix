<?php

declare(strict_types=1);

namespace App\Domain\Support\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Support\Carbon;

/**
 * A photo / PDF on a ticket message (PHASE-8-9C P89C-15), backed by a private `media` row (purpose
 * `support_attachment`). Unattached uploads (message_id null) are pruned after 24 h.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string|null $ticket_id
 * @property string|null $message_id
 * @property string $media_id
 * @property string $uploaded_by_type
 * @property string|null $uploaded_by_user_id
 * @property string $filename
 * @property string $mime
 * @property int $size_bytes
 * @property Carbon $created_at
 */
class SupportTicketAttachment extends Model
{
    use BelongsToTenant, HasUlids;

    public const BY_MERCHANT = 'merchant';

    public const BY_STAFF = 'staff';

    public const UPDATED_AT = null;

    protected $table = 'support_ticket_attachments';

    protected $fillable = [];

    protected function casts(): array
    {
        return ['size_bytes' => 'integer'];
    }
}
