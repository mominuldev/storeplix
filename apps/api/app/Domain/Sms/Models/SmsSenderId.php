<?php

declare(strict_types=1);

namespace App\Domain\Sms\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Media\Models\Media;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * A masked sender ID request (PHASE-8-9A §3.1, §8). Store-scoped [S]: every merchant query filters `store_id`.
 * States: pending → approved | rejected | cancelled; approved → superseded | revoked. One pending and one approved row
 * per store; the ID is unique case-insensitively among pending + approved rows of every shop. Nothing is
 * mass-assignable.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $sender_id
 * @property string $business_name
 * @property list<string> $uses
 * @property string|null $note
 * @property string $status
 * @property string $document_media_id
 * @property Carbon $rights_confirmed_at
 * @property string|null $requested_by
 * @property Carbon $requested_at
 * @property string|null $reviewed_by
 * @property Carbon|null $reviewed_at
 * @property string|null $decision_reason
 * @property Carbon|null $approved_at
 * @property Carbon|null $ended_at
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read Media|null $document
 * @property-read User|null $requestedBy
 * @property-read User|null $reviewedBy
 */
class SmsSenderId extends Model
{
    use BelongsToTenant, HasUlids;

    public const PENDING = 'pending';

    public const APPROVED = 'approved';

    public const REJECTED = 'rejected';

    public const CANCELLED = 'cancelled';

    public const SUPERSEDED = 'superseded';

    public const REVOKED = 'revoked';

    public const STATUSES = [self::PENDING, self::APPROVED, self::REJECTED, self::CANCELLED, self::SUPERSEDED, self::REVOKED];

    /** States in which the request is over (its document may be pruned after the retention period). */
    public const ENDED = [self::REJECTED, self::CANCELLED, self::SUPERSEDED, self::REVOKED];

    public const USES = ['order_updates', 'otp', 'pos_receipts'];

    protected $table = 'sms_sender_ids';

    protected $fillable = [];

    protected function casts(): array
    {
        return [
            'uses' => 'array',
            'rights_confirmed_at' => 'datetime',
            'requested_at' => 'datetime',
            'reviewed_at' => 'datetime',
            'approved_at' => 'datetime',
            'ended_at' => 'datetime',
        ];
    }

    public function document(): BelongsTo
    {
        return $this->belongsTo(Media::class, 'document_media_id');
    }

    public function requestedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'requested_by');
    }

    public function reviewedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'reviewed_by');
    }
}
