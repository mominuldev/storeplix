<?php

declare(strict_types=1);

namespace App\Domain\Automations\Models;

use App\Domain\Automations\Recipes\Recipe;
use App\Domain\Automations\Recipes\RecipeCatalogue;
use App\Domain\Identity\Models\User;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Concerns\BelongsToTenant;
use Illuminate\Database\Eloquent\Concerns\HasUlids;
use Illuminate\Database\Eloquent\Model;
use Illuminate\Database\Eloquent\Relations\BelongsTo;
use Illuminate\Database\Eloquent\Relations\HasMany;
use Illuminate\Support\Carbon;

/**
 * A store's instance of a recipe (PHASE-8-6 §3, P86-1: one per recipe per store). Nothing is mass-assignable:
 * AutomationService maps fields. Status: draft → on ⇄ off; only a draft that never ran can be deleted.
 *
 * @property string $id
 * @property string $tenant_id
 * @property string $store_id
 * @property string $recipe
 * @property string $name
 * @property string $status draft|on|off
 * @property array<string, mixed> $settings
 * @property Carbon|null $last_run_at
 * @property string|null $created_by
 * @property int $revision
 * @property Carbon $created_at
 * @property Carbon $updated_at
 */
class Automation extends Model
{
    use BelongsToTenant, HasUlids;

    public const DRAFT = 'draft';

    public const ON = 'on';

    public const OFF = 'off';

    public const STATUSES = [self::DRAFT, self::ON, self::OFF];

    protected $fillable = [];

    protected $attributes = ['status' => self::DRAFT, 'revision' => 1];

    protected function casts(): array
    {
        return ['settings' => 'array', 'last_run_at' => 'datetime', 'revision' => 'integer'];
    }

    /** Always a JSON object (Postgres CHECK jsonb_typeof = 'object'), also for the empty `low_stock` settings. @param array<string, mixed>|null $value */
    public function setSettingsAttribute(?array $value): void
    {
        $this->attributes['settings'] = json_encode($value === null || $value === [] ? new \stdClass : $value, JSON_THROW_ON_ERROR);
    }

    /** Settings in the recipe's documented key order (jsonb does not keep key order). @return array<string, mixed> */
    public function orderedSettings(): array
    {
        return self::orderLike((array) $this->settings, $this->recipeDefinition()->defaults('en'));
    }

    /** @param array<string, mixed> $value @param array<string, mixed> $template @return array<string, mixed> */
    private static function orderLike(array $value, array $template): array
    {
        if (array_is_list($value) && $value !== []) {
            return $value;
        }
        $out = [];
        foreach ($template as $key => $sub) {
            if (array_key_exists($key, $value)) {
                $out[$key] = is_array($value[$key]) && is_array($sub) && ! array_is_list($sub) ? self::orderLike($value[$key], $sub) : $value[$key];
            }
        }

        return $out + $value;
    }

    public function store(): BelongsTo
    {
        return $this->belongsTo(Store::class);
    }

    public function createdBy(): BelongsTo
    {
        return $this->belongsTo(User::class, 'created_by');
    }

    public function runs(): HasMany
    {
        return $this->hasMany(AutomationRun::class);
    }

    public function recipeDefinition(): Recipe
    {
        return RecipeCatalogue::get($this->recipe);
    }

    public function isOn(): bool
    {
        return $this->status === self::ON;
    }
}
