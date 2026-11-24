<?php

declare(strict_types=1);

namespace App\Domain\Marketing\Audience;

use App\Domain\Shared\Support\Money;
use Illuminate\Validation\ValidationException;

/**
 * The `audience` jsonb (PHASE-8-5 §3.2): one predefined segment with bounded params + exclusions. Opted-out and
 * ineligible customers (P85-3) are always excluded — not a flag. Unknown keys → 422. Missing params take the §3.2
 * defaults; the normalized form always has `params` (an empty object for `all` / `one_time`) and both exclusions.
 */
final class AudienceDefinition
{
    public const SEGMENTS = ['all', 'repeat_inactive', 'vip', 'new_customers', 'one_time', 'district', 'tag'];

    /** segment → param → [default, min, max] (null = unbounded). */
    private const INT_PARAMS = [
        'repeat_inactive' => ['min_orders' => [2, 2, 20], 'inactive_days' => [60, 14, 365]],
        'vip' => ['min_spent_amount' => [2_000_000, 1, null]],
        'new_customers' => ['days' => [30, 1, 365]],
    ];

    /**
     * @param  array<string, mixed>  $segmentParams
     * @param  array{risky: bool, ordered_within_days: int|null}  $exclude
     */
    private function __construct(
        public readonly string $segment,
        public readonly array $segmentParams,
        public readonly array $exclude,
    ) {}

    /** @throws ValidationException */
    public static function from(mixed $input, string $attribute = 'audience'): self
    {
        $fail = fn (string $key, string $message) => throw ValidationException::withMessages([$key => [$message]]);
        if (! is_array($input) || array_is_list($input) && $input !== []) {
            $fail($attribute, 'Choose who gets this campaign.');
        }
        foreach (array_keys($input) as $key) {
            if (! in_array($key, ['segment', 'params', 'exclude'], true)) {
                $fail("{$attribute}.{$key}", 'This field is not allowed.');
            }
        }
        $segment = $input['segment'] ?? null;
        if (! is_string($segment) || ! in_array($segment, self::SEGMENTS, true)) {
            $fail("{$attribute}.segment", 'Choose a segment.');
        }

        $raw = $input['params'] ?? [];
        if (! is_array($raw) || (array_is_list($raw) && $raw !== [])) {
            $fail("{$attribute}.params", 'Invalid segment settings.');
        }
        $params = [];
        $allowed = match ($segment) {
            'district' => ['districts'],
            'tag' => ['tag'],
            default => array_keys(self::INT_PARAMS[$segment] ?? []),
        };
        foreach (array_keys($raw) as $key) {
            if (! in_array($key, $allowed, true)) {
                $fail("{$attribute}.params.{$key}", 'This field is not allowed for this segment.');
            }
        }
        foreach (self::INT_PARAMS[$segment] ?? [] as $key => [$default, $min, $max]) {
            $value = $raw[$key] ?? $default;
            if (! is_int($value) || $value < $min || ($max !== null && $value > $max)) {
                $fail("{$attribute}.params.{$key}", $max === null ? "Enter a whole number of at least {$min}." : "Enter a whole number from {$min} to {$max}.");
            }
            $params[$key] = $value;
        }
        if ($segment === 'district') {
            $districts = $raw['districts'] ?? null;
            if (! is_array($districts) || ! array_is_list($districts) || count($districts) < 1 || count($districts) > 10) {
                $fail("{$attribute}.params.districts", 'Choose 1 to 10 districts.');
            }
            $clean = [];
            foreach ($districts as $i => $d) {
                if (! is_string($d) || trim($d) === '' || mb_strlen(trim($d)) > 80 || preg_match('/[\x00-\x1F\x7F]/u', $d) === 1) {
                    $fail("{$attribute}.params.districts.{$i}", 'Enter a district name.');
                }
                $clean[] = trim($d);
            }
            $params['districts'] = array_values(array_unique($clean));
        }
        if ($segment === 'tag') {
            $tag = $raw['tag'] ?? null;
            if (! is_string($tag) || trim($tag) === '' || mb_strlen(trim($tag)) > 40 || preg_match('/[\x00-\x1F\x7F]/u', $tag) === 1) {
                $fail("{$attribute}.params.tag", 'Enter a tag (1–40 characters).');
            }
            $params['tag'] = mb_strtolower(trim($tag));
        }

        $rawExclude = $input['exclude'] ?? [];
        if (! is_array($rawExclude) || (array_is_list($rawExclude) && $rawExclude !== [])) {
            $fail("{$attribute}.exclude", 'Invalid exclusions.');
        }
        foreach (array_keys($rawExclude) as $key) {
            if (! in_array($key, ['risky', 'ordered_within_days'], true)) {
                $fail("{$attribute}.exclude.{$key}", 'This field is not allowed.');
            }
        }
        $risky = $rawExclude['risky'] ?? false;
        if (! is_bool($risky)) {
            $fail("{$attribute}.exclude.risky", 'Must be true or false.');
        }
        $within = $rawExclude['ordered_within_days'] ?? null;
        if ($within !== null && (! is_int($within) || $within < 1 || $within > 60)) {
            $fail("{$attribute}.exclude.ordered_within_days", 'Enter a whole number from 1 to 60, or leave it empty.');
        }

        return new self($segment, $params, ['risky' => $risky, 'ordered_within_days' => $within]);
    }

    /** @return array{segment: string, params: array<string, mixed>, exclude: array{risky: bool, ordered_within_days: int|null}} */
    public function toArray(): array
    {
        return ['segment' => $this->segment, 'params' => $this->segmentParams, 'exclude' => $this->exclude];
    }

    /** For JSON output: `params` is an object even when empty. @return array<string, mixed> */
    public static function present(array $audience): array
    {
        return [
            'segment' => $audience['segment'] ?? 'all',
            'params' => (object) ($audience['params'] ?? []),
            'exclude' => [
                'risky' => (bool) ($audience['exclude']['risky'] ?? false),
                'ordered_within_days' => $audience['exclude']['ordered_within_days'] ?? null,
            ],
        ];
    }

    /** Segment label in the campaign language (§3.2 "Label (UI)"). @param array<string, mixed> $audience */
    public static function label(array $audience, string $language): string
    {
        $p = $audience['params'] ?? [];
        $bn = $language === 'bn';

        return match ($audience['segment'] ?? 'all') {
            'repeat_inactive' => $bn
                ? "{$p['min_orders']}+ বার কিনেছেন, {$p['inactive_days']} দিন নিষ্ক্রিয়"
                : "Bought {$p['min_orders']}+ times, inactive {$p['inactive_days']} days",
            'vip' => $bn
                ? 'ভিআইপি · ৳ '.Money::plain((int) $p['min_spent_amount']).'-এর বেশি খরচ'
                : 'VIP · spent over ৳ '.Money::plain((int) $p['min_spent_amount']),
            'new_customers' => $bn ? "গত {$p['days']} দিনে প্রথম অর্ডার" : "First order in the last {$p['days']} days",
            'one_time' => $bn ? 'একবার অর্ডার করেছেন' : 'Ordered once',
            'district' => $bn ? implode(', ', $p['districts'] ?? []).'-এর গ্রাহক' : 'Customers in '.implode(', ', $p['districts'] ?? []),
            'tag' => $bn ? "ট্যাগ \"{$p['tag']}\"" : "Tagged \"{$p['tag']}\"",
            default => $bn ? 'যাদের মেসেজ পাঠানো যায় এমন সব গ্রাহক' : 'All customers you can message',
        };
    }
}
