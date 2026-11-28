<?php

declare(strict_types=1);

namespace App\Domain\Sms\Models;

use App\Domain\Identity\Models\User;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Support\Carbon;

/**
 * A store's custom SMS body for one (key, language) (PHASE-8-9A §3.1, §7). Store-scoped [S]: every query filters
 * `store_id`. Only custom bodies are stored; the defaults are resources/sms/{bn,en}.php. Nothing is mass-assignable.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $key
 * @property string $language
 * @property string $body
 * @property int $revision
 * @property string|null $updated_by
 * @property Carbon $created_at
 * @property Carbon $updated_at
 * @property-read User|null $updatedBy
 */
class SmsTemplate extends Model
{
    use BelongsToTenant, HasUlids;

    protected $fillable = [];

    protected $attributes = ['revision' => 1];

    protected function casts(): array
    {
        return ['revision' => 'integer'];
    }

    public function updatedBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'updated_by');
    }
}
