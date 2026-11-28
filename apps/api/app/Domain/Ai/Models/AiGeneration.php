<?php

declare(strict_types=1);

namespace App\Domain\Ai\Models;

use App\Domain\Catalog\Models\Product;
use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * One AI job (PHASE-8-9D §3.2, §11): a product description request or a photo edit. Store-scoped; looked up with
 * `where('store_id', …)` inside the tenant scope (S330). Output text is model-made data and is only ever presented
 * after sanitizing (P89D-53); the row never holds a secret.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $kind
 * @property string $status
 * @property string|null $product_id
 * @property string|null $source_media_id
 * @property string|null $result_media_id
 * @property string|null $original_media_id
 * @property array<string, mixed> $input
 * @property array<string, mixed>|null $output
 * @property int $credits
 * @property string|null $charged_from
 * @property bool $refunded
 * @property string $provider
 * @property string|null $model
 * @property array<string, mixed>|null $usage
 * @property array<string, mixed> $flags
 * @property string|null $error_code
 * @property string|null $requested_by
 * @property string $idempotency_key
 * @property string $request_hash
 * @property Carbon|null $finished_at
 * @property Carbon|null $applied_at
 * @property Carbon|null $undone_at
 * @property Carbon|null $original_kept_until
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read Product|null $product
 * @property-read User|null $requester
 */
class AiGeneration extends Model
{
    use BelongsToTenant, HasUlids;

    public const DESCRIPTION = 'product_description';

    public const PHOTO = 'photo_edit';

    public const KINDS = [self::DESCRIPTION, self::PHOTO];

    public const QUEUED = 'queued';

    public const RUNNING = 'running';

    public const SUCCEEDED = 'succeeded';

    public const FAILED = 'failed';

    public const APPLIED = 'applied';

    public const UNDONE = 'undone';

    public const STATUSES = [self::QUEUED, self::RUNNING, self::SUCCEEDED, self::FAILED, self::APPLIED, self::UNDONE];

    public const ERROR_CODES = ['ai_refused', 'ai_unavailable', 'ai_timeout', 'ai_output_invalid', 'image_unsupported', 'provider_error'];

    protected $fillable = [];

    protected $attributes = ['flags' => '{}', 'refunded' => false];

    protected function casts(): array
    {
        return [
            'input' => 'array',
            'output' => 'array',
            'usage' => 'array',
            'flags' => 'array',
            'credits' => 'integer',
            'refunded' => 'boolean',
            'finished_at' => 'datetime',
            'applied_at' => 'datetime',
            'undone_at' => 'datetime',
            'original_kept_until' => 'datetime',
        ];
    }

    public function product(): BelongsTo
    {
        return $this->belongsTo(Product::class);
    }

    public function requester(): BelongsTo
    {
        return $this->belongsTo(User::class, 'requested_by');
    }

    public function isFinal(): bool
    {
        return ! in_array($this->status, [self::QUEUED, self::RUNNING], true);
    }
}
