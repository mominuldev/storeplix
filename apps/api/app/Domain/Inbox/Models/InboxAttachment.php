<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Models;

use App\Domain\Media\Models\Media;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * A photo / PDF on a message or a saved reply (PHASE-8-8E P88E-7), backed by a private `media` row
 * (purpose `inbox_attachment`). Unattached uploads are pruned after 24 h.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $media_id
 * @property string|null $message_id
 * @property string|null $saved_reply_id
 * @property string $uploaded_by_type
 * @property string|null $uploaded_by_user_id
 * @property string|null $widget_session_id
 * @property string $filename
 * @property string $mime
 * @property int $size_bytes
 * @property Carbon $created_at
 */
class InboxAttachment extends Model
{
    use BelongsToTenant, HasUlids;

    public const BY_USER = 'user';

    public const BY_SHOPPER = 'shopper';

    public const BY_EMAIL = 'email';

    public const UPDATED_AT = null;

    protected $table = 'inbox_attachments';

    protected $fillable = [];

    protected function casts(): array
    {
        return ['size_bytes' => 'integer'];
    }

    public function media(): BelongsTo
    {
        return $this->belongsTo(Media::class, 'media_id');
    }
}
