<?php

declare(strict_types=1);

namespace App\Domain\Automations\Recipes;

use App\Domain\Automations\Engine\Subject;
use App\Domain\Stores\Models\Store;
use Illuminate\Support\Carbon;

/**
 * `low_stock` "Low stock alert" (§3, P86-19): stock crossed the variant's effective threshold → email the team.
 * Dedupe `inventory:{id}:{day}` (one alert per row per store day).
 */
final class LowStock extends Recipe
{
    public function key(): string
    {
        return 'low_stock';
    }

    public function name(): string
    {
        return 'Low stock alert';
    }

    public function description(): string
    {
        return 'Email the team when a product runs low.';
    }

    public function icon(): string
    {
        return 'package';
    }

    public function trigger(): string
    {
        return 'stock.low';
    }

    public function triggerDescription(): string
    {
        return 'Stock of a variant falls to its low-stock threshold.';
    }

    public function triggerLabel(array $settings): string
    {
        return 'Stock below threshold';
    }

    public function actionLabel(array $settings): string
    {
        return 'Email the team';
    }

    public function subjectTypes(): array
    {
        return ['inventory'];
    }

    public function defaults(string $language): array
    {
        return [];
    }

    protected function rules(): array
    {
        return ['' => ['present', 'array', 'max:0']];
    }

    protected function finish(Store $store, array $settings): array
    {
        return [];
    }

    public function flow(array $settings): array
    {
        return [['kind' => 'notify_team', 'index' => 1]];
    }

    public function schemaSteps(): array
    {
        return [['kind' => 'notify_team', 'title' => 'Email the team', 'description' => 'Owner, managers and members who adjust stock.', 'optional' => false, 'message_step' => null]];
    }

    public function dedupeKey(Subject $subject, array $settings, bool $conditionsPassed, Store $store): string
    {
        return 'inventory:'.$subject->id.':'.Carbon::now()->setTimezone((string) ($store->timezone ?: 'Asia/Dhaka'))->format('Y-m-d');
    }
}
