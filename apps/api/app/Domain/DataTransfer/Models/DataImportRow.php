<?php

namespace App\Domain\DataTransfer\Models;

use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;

/**
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $import_id
 * @property int $row_number
 * @property string $status
 * @property string $action
 * @property string $label
 * @property string|null $key
 * @property array<string, mixed> $values
 * @property list<array{level: string, field: string|null, message: string}> $messages
 * @property string|null $result_id
 */
class DataImportRow extends Model
{
    use BelongsToTenant, HasUlids;

    public $timestamps = false;

    protected $fillable = ['row_number', 'status', 'action', 'label', 'key', 'values', 'messages', 'result_id'];

    protected function casts(): array
    {
        return ['row_number' => 'integer', 'values' => 'array', 'messages' => 'array'];
    }

    public function import(): BelongsTo
    {
        return $this->belongsTo(DataImport::class, 'import_id');
    }
}
