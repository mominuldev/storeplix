<?php

namespace App\Domain\DataTransfer\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;

/**
 * CSV import (P4-18). Internal table: written only by ImportService and the import jobs.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $type
 * @property string $status
 * @property string $file_path
 * @property string $filename
 * @property int $size_bytes
 * @property string $checksum
 * @property string $delimiter
 * @property list<string> $headers
 * @property array<string, string|null> $samples
 * @property array<string, string|null>|null $column_map
 * @property array<string, bool> $options
 * @property int|null $row_count
 * @property int $processed_rows
 * @property array<string, int>|null $summary
 * @property string|null $failure_reason
 * @property Carbon|null $validated_at
 * @property Carbon|null $started_at
 * @property Carbon|null $completed_at
 * @property string|null $created_by
 * @property Carbon $created_at
 * @property-read User|null $createdBy
 */
class DataImport extends Model
{
    use BelongsToTenant, HasUlids;

    public const PRODUCTS = 'products';

    public const CUSTOMERS = 'customers';

    public const TYPES = [self::PRODUCTS, self::CUSTOMERS];

    public const UPLOADED = 'uploaded';

    public const VALIDATING = 'validating';

    public const VALIDATED = 'validated';

    public const IMPORTING = 'importing';

    public const COMPLETED = 'completed';

    public const FAILED = 'failed';

    public const CANCELLED = 'cancelled';

    public const DEFAULT_OPTIONS = ['update_existing' => true, 'import_as_draft' => false, 'create_missing_categories' => true];

    protected $fillable = [
        'type', 'status', 'file_path', 'filename', 'size_bytes', 'checksum', 'delimiter', 'headers', 'samples',
        'column_map', 'options', 'row_count', 'processed_rows', 'summary', 'failure_reason', 'validated_at',
        'started_at', 'completed_at', 'created_by',
    ];

    protected $attributes = ['options' => '{}', 'processed_rows' => 0];

    protected function casts(): array
    {
        return [
            'headers' => 'array',
            'samples' => 'array',
            'column_map' => 'array',
            'options' => 'array',
            'summary' => 'array',
            'size_bytes' => 'integer',
            'row_count' => 'integer',
            'processed_rows' => 'integer',
            'validated_at' => 'datetime',
            'started_at' => 'datetime',
            'completed_at' => 'datetime',
        ];
    }

    public function isActive(): bool
    {
        return in_array($this->status, [self::VALIDATING, self::IMPORTING], true);
    }

    public function store(): BelongsTo
    {
        return $this->belongsTo(Store::class);
    }

    public function rows(): HasMany
    {
        return $this->hasMany(DataImportRow::class, 'import_id');
    }

    public function createdBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }
}
