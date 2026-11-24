<?php

declare(strict_types=1);

namespace App\Domain\Automations\Http\Resources;

use App\Domain\Automations\AutomationStats;
use App\Domain\Automations\Models\Automation;
use App\Domain\Automations\Recipes\RecipeCatalogue;
use App\Domain\Identity\Models\User;
use App\Domain\Shared\Http\UserRef;
use App\Domain\Tenancy\Models\AuditLog;

/** PHASE-8-6 §9.2 shapes: Automation, AutomationDetail (C3/C4), RecipeCard. */
final class AutomationPresenter
{
    /** @param array<string, int> $runs7d @return array<string, mixed> */
    public static function automation(Automation $a, array $runs7d, bool $planAllows): array
    {
        $recipe = $a->recipeDefinition();
        $settings = (array) $a->settings;

        return [
            'id' => $a->id,
            'recipe' => $a->recipe,
            'name' => $a->name,
            'status' => $a->status,
            'paused_reason' => $a->status === Automation::ON && ! $planAllows ? 'plan' : null,
            'settings' => (object) $a->orderedSettings(),
            'trigger_label' => $recipe->triggerLabel($settings),
            'action_label' => $recipe->actionLabel($settings),
            'runs_7d' => (int) ($runs7d[$a->id] ?? 0),
            'last_run_at' => UserRef::iso($a->last_run_at),
            'created_at' => UserRef::iso($a->created_at),
            'updated_at' => UserRef::iso($a->updated_at),
            'revision' => (int) $a->revision,
        ];
    }

    /** @return array<string, mixed> */
    public static function detail(Automation $a, bool $planAllows): array
    {
        return self::automation($a, AutomationStats::runs7d([$a->id]), $planAllows) + [
            'recipe_schema' => $a->recipeDefinition()->schema(),
            'stats_7d' => AutomationStats::stats7d($a),
            'last_edited_by' => self::lastEditedBy($a),
        ];
    }

    /** @param list<string> $added recipe keys the store has @return list<array<string, mixed>> */
    public static function recipeCards(array $added): array
    {
        $cards = [];
        foreach (RecipeCatalogue::all() as $recipe) {
            $defaults = $recipe->defaults('en');
            $cards[] = [
                'recipe' => $recipe->key(),
                'name' => $recipe->name(),
                'description' => $recipe->description(),
                'trigger_label' => $recipe->triggerLabel($defaults),
                'action_label' => $recipe->actionLabel($defaults),
                'icon' => $recipe->icon(),
                'added' => in_array($recipe->key(), $added, true),
            ];
        }

        return $cards;
    }

    /** @return array{id: string, name: string}|null */
    private static function lastEditedBy(Automation $a): ?array
    {
        $row = AuditLog::query()->where('tenant_id', $a->tenant_id)->where('subject_type', 'automation')->where('subject_id', $a->id)
            ->whereIn('action', ['automation.created', 'automation.updated'])->where('actor_type', 'user')
            ->orderByDesc('created_at')->orderByDesc('id')->first(['actor_id']);

        return $row?->actor_id !== null ? UserRef::of(User::query()->find($row->actor_id)) : null;
    }
}
