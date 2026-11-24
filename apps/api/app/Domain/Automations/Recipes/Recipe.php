<?php

declare(strict_types=1);

namespace App\Domain\Automations\Recipes;

use App\Domain\Automations\Engine\Subject;
use App\Domain\Automations\Messages\AutomationMessages;
use App\Domain\Coupons\Models\Coupon;
use App\Domain\Marketing\Content\StoreBrand;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use Illuminate\Support\Facades\Validator;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

/**
 * A code-defined recipe (PHASE-8-6 §3, P86-1). Each recipe fixes its trigger, dedupe key, allowed conditions, the steps
 * (fixed order), parameters with defaults/bounds and default messages (bn + en). `settings` is validated by the recipe's
 * schema; unknown keys → 422.
 *
 * Flow steps (`flow()`), in order:
 *  - `['kind' => 'send_message', 'index' => n, 'message_step' => 1|2, 'enabled' => bool, 'message' => [...], 'coupon_id' => ?string]`
 *  - `['kind' => 'add_tag', 'index' => n, 'tag' => string]`, `['kind' => 'notify_team', 'index' => n]`
 *  - `['kind' => 'wait', 'from' => 'now'|'start', 'hours' => int]` or `['kind' => 'wait', 'until' => 'window']`
 * `index` = 1-based position among the actions (the step row's `step_index`); waits never get a row.
 */
abstract class Recipe
{
    abstract public function key(): string;

    abstract public function name(): string;

    abstract public function description(): string;

    abstract public function icon(): string;

    /** §4.1 trigger key. */
    abstract public function trigger(): string;

    /** "When" step copy (RecipeSchema.trigger_description). */
    abstract public function triggerDescription(): string;

    /** @param array<string, mixed> $settings Figma tag text, e.g. "Checkout left 30 min" */
    abstract public function triggerLabel(array $settings): string;

    /** @param array<string, mixed> $settings Figma tag text, e.g. "Reminder SMS" */
    abstract public function actionLabel(array $settings): string;

    /** @return array<string, mixed> */
    abstract public function defaults(string $language): array;

    /** @return list<string> §5 condition fields this recipe allows */
    public function conditionFields(): array
    {
        return [];
    }

    /** @return list<string> §8 merge fields this recipe's messages may use */
    public function mergeFields(): array
    {
        return [];
    }

    /**
     * Laravel rules for `settings` (keys relative to settings; `array:` lists reject unknown keys).
     *
     * @return array<string, mixed>
     */
    abstract protected function rules(): array;

    /**
     * Checks beyond the rules (messages, coupons, conditions); returns the normalized settings.
     *
     * @param  array<string, mixed>  $settings  passed the rules
     * @return array<string, mixed>
     */
    abstract protected function finish(Store $store, array $settings): array;

    /**
     * Settings paths still missing before the automation may run (enable → 422 automation_incomplete).
     *
     * @param  array<string, mixed>  $settings
     * @return list<string>
     */
    public function incomplete(array $settings): array
    {
        return [];
    }

    /**
     * The conditions evaluated at run time (§5), derived from settings.
     *
     * @param  array<string, mixed>  $settings
     * @return list<array{field: string, op: string, value: mixed}>
     */
    public function conditions(array $settings): array
    {
        return [];
    }

    /**
     * @param  array<string, mixed>  $settings
     * @return list<array<string, mixed>>
     */
    abstract public function flow(array $settings): array;

    /**
     * RecipeSchema.steps (editor).
     *
     * @return list<array{kind: string, title: string, description: string, optional: bool, message_step: int|null}>
     */
    abstract public function schemaSteps(): array;

    /** @param array<string, mixed> $settings P86-4 dedupe key (≤ 120 chars) */
    abstract public function dedupeKey(Subject $subject, array $settings, bool $conditionsPassed, Store $store): string;

    /** Subject types this recipe accepts (dry run, trigger). @return list<string> */
    abstract public function subjectTypes(): array;

    /** Recovery semantics (P86-11, P86-13 … P86-16): contact eligibility, exit window, cart link, conversions. */
    public function isRecovery(): bool
    {
        return false;
    }

    /**
     * Validates and normalizes `settings` for this store.
     *
     * @param  array<string, mixed>  $settings
     * @return array<string, mixed>
     *
     * @throws ValidationException|ApiException
     */
    public function validate(Store $store, mixed $settings): array
    {
        if (! is_array($settings) || ($settings !== [] && array_is_list($settings))) {
            throw ValidationException::withMessages(['settings' => ['The settings must be an object.']]);
        }
        $validator = Validator::make(['settings' => $settings], $this->prefixed($this->rules()));
        if ($validator->fails()) {
            throw new ValidationException($validator);
        }

        return $this->finish($store, $settings);
    }

    /** The message of message step `n` (test message, dry run). @param array<string, mixed> $settings @return array<string, mixed>|null */
    public function messageStep(array $settings, int $n): ?array
    {
        foreach ($this->flow($settings) as $step) {
            if ($step['kind'] === 'send_message' && $step['message_step'] === $n) {
                return $step;
            }
        }

        return null;
    }

    /** @return array<string, mixed> RecipeSchema */
    public function schema(): array
    {
        return [
            'trigger' => $this->trigger(),
            'trigger_description' => $this->triggerDescription(),
            'allowed_conditions' => $this->conditionFields(),
            'max_conditions' => 5,
            'steps' => $this->schemaSteps(),
            'merge_fields' => $this->mergeFields(),
            'sms_max_parts' => (int) config('automations.sms_max_parts', 3),
        ];
    }

    /** @param array<string, mixed> $rules @return array<string, mixed> */
    private function prefixed(array $rules): array
    {
        $out = ['settings' => $rules[''] ?? ['array']];
        unset($rules['']);
        foreach ($rules as $key => $rule) {
            $out['settings.'.$key] = $rule;
        }

        return $out;
    }

    // --- shared helpers for subclasses ---

    /** Rules for a message object at `$path`. @return array<string, mixed> */
    protected static function messageRules(string $path, bool $withEnabled = false): array
    {
        return [
            $path => ['required', $withEnabled ? 'array:enabled,channel,language,body,subject' : 'array:channel,language,body,subject'],
            "{$path}.channel" => ['required', 'string', Rule::in(['sms', 'email'])],
            "{$path}.language" => ['required', 'string', Rule::in(['bn', 'en'])],
            "{$path}.body" => ['required', 'string', 'max:'.(int) config('automations.email_body_max', 3000)],
            "{$path}.subject" => ['present', 'nullable', 'string', 'max:150', 'not_regex:/[\r\n]/'],
        ] + ($withEnabled ? ["{$path}.enabled" => ['required', 'boolean']] : []);
    }

    /**
     * Normalizes and checks one message (P86-7, §8): subject only for email (required, single line, ≤ 150), body
     * length per channel, the recipe's merge fields only (422 campaign_unknown_merge_field), ≤ 3 SMS parts with the
     * sample render (422 campaign_too_long).
     *
     * @param  array<string, mixed>  $message
     * @return array{channel: string, language: string, body: string, subject: string|null}
     */
    protected function message(Store $store, array $message, string $path, ?Coupon $coupon): array
    {
        $channel = (string) $message['channel'];
        $body = trim(str_replace(["\r\n", "\r"], "\n", (string) $message['body']));
        $subject = $channel === 'email' ? trim((string) ($message['subject'] ?? '')) : null;
        if ($body === '') {
            throw ValidationException::withMessages(["settings.{$path}.body" => ['Write the message.']]);
        }
        if ($channel === 'email' && $subject === '') {
            throw ValidationException::withMessages(["settings.{$path}.subject" => ['Enter a subject for the email.']]);
        }
        if ($channel === 'sms' && mb_strlen($body) > (int) config('automations.sms_body_max', 1000)) {
            throw ValidationException::withMessages(["settings.{$path}.body" => ['The SMS is too long.']]);
        }
        $out = ['channel' => $channel, 'language' => (string) $message['language'], 'body' => $body, 'subject' => $subject];
        AutomationMessages::assertValid($this, StoreBrand::of($store), $out, $coupon);

        return $out;
    }

    /** A coupon of this store (422 when unknown, 422 campaign_coupon_inactive when not active). */
    protected static function coupon(Store $store, ?string $couponId, string $path): ?Coupon
    {
        if ($couponId === null) {
            return null;
        }
        $coupon = Coupon::query()->where('store_id', $store->id)->whereKey(strtolower($couponId))->first();
        if ($coupon === null) {
            throw ValidationException::withMessages(["settings.{$path}" => ['Choose one of your coupons.']]);
        }
        if ($coupon->displayStatus() !== 'active') {
            throw new ApiException(422, 'campaign_coupon_inactive', "The coupon {$coupon->code} isn't active. Activate it or choose another coupon.", ["settings.{$path}" => ["The coupon {$coupon->code} isn't active."]]);
        }

        return $coupon;
    }

    protected static function tag(string $tag): string
    {
        return mb_strtolower(trim($tag));
    }

    /** @return array<string, mixed> tag rules */
    protected static function tagRules(): array
    {
        return ['required', 'string', 'min:1', 'max:40', 'not_regex:/[\x00-\x1F\x7F]/'];
    }

    /** @param array<string, mixed> $message */
    protected static function usesCoupon(array $message): bool
    {
        return str_contains((string) ($message['body'] ?? ''), '{coupon}') || str_contains((string) ($message['subject'] ?? ''), '{coupon}');
    }

    /** @param array<string, mixed> $message "SMS" / "email" for labels */
    protected static function channelWord(array $message, bool $capital = true): string
    {
        return ($message['channel'] ?? 'sms') === 'email' ? ($capital ? 'Email' : 'email') : 'SMS';
    }
}
