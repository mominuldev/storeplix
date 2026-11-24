<?php

declare(strict_types=1);

namespace App\Domain\Automations\Recipes;

use App\Domain\Automations\Engine\Subject;
use App\Domain\Stores\Models\Store;

/** `return_flag` "Handle returns" (§3): parcel returned → tag the buyer. Restock stays in Returns (P5B-65). */
final class ReturnFlag extends Recipe
{
    public function key(): string
    {
        return 'return_flag';
    }

    public function name(): string
    {
        return 'Handle returns';
    }

    public function description(): string
    {
        return 'Flag buyers whose parcel came back. Restock stays in Returns.';
    }

    public function icon(): string
    {
        return 'rotate-ccw';
    }

    public function trigger(): string
    {
        return 'return.received';
    }

    public function triggerDescription(): string
    {
        return 'A returned parcel is received.';
    }

    public function triggerLabel(array $settings): string
    {
        return 'Parcel returned';
    }

    public function actionLabel(array $settings): string
    {
        return 'Flag buyer';
    }

    public function subjectTypes(): array
    {
        return ['return'];
    }

    public function defaults(string $language): array
    {
        return ['tag' => 'Returned'];
    }

    protected function rules(): array
    {
        return ['' => ['required', 'array:tag'], 'tag' => self::tagRules()];
    }

    protected function finish(Store $store, array $settings): array
    {
        return ['tag' => trim((string) $settings['tag'])];
    }

    public function flow(array $settings): array
    {
        return [['kind' => 'add_tag', 'index' => 1, 'tag' => (string) ($settings['tag'] ?? 'Returned')]];
    }

    public function schemaSteps(): array
    {
        return [['kind' => 'add_tag', 'title' => 'Flag the buyer', 'description' => 'Adds the tag to the customer. Restock stays in Returns.', 'optional' => false, 'message_step' => null]];
    }

    public function dedupeKey(Subject $subject, array $settings, bool $conditionsPassed, Store $store): string
    {
        return 'return:'.$subject->id;
    }
}
