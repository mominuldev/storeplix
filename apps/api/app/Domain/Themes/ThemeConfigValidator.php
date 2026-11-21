<?php

namespace App\Domain\Themes;

use App\Domain\Media\Models\Media;
use App\Domain\Pages\RichTextValidator;
use App\Domain\Shared\Http\ApiException;
use Illuminate\Validation\ValidationException;
use Opis\JsonSchema\Errors\ValidationError;
use Opis\JsonSchema\Validator;
use stdClass;

/**
 * Validates a theme config for PUT …/draft (PHASE-3-CONTRACT §3.1), stages 2–4:
 * normalise → theme/major check → JSON Schema (opis, draft 2020-12) → semantic checks.
 * Errors are dot paths relative to the request ("config.sections.1.settings.limit"), max 50.
 */
class ThemeConfigValidator
{
    private ?Validator $opis = null;

    public function __construct(private readonly ThemeRegistry $registry) {}

    /**
     * @param  stdClass|array<string, mixed>  $config  decoded JSON (objects preserved when possible)
     * @param  bool  $checkMedia  false for fixtures/migrations (no tenant context)
     * @return array<string, mixed> normalised config (assoc arrays)
     *
     * @throws ValidationException|ApiException
     */
    public function validate(string $code, stdClass|array $config, bool $checkMedia = true, string $prefix = 'config'): array
    {
        $data = self::normalise(self::toObject($config));

        if (! $data instanceof stdClass) {
            throw ValidationException::withMessages([$prefix => ['The theme config must be an object.']]);
        }

        $this->assertTheme($code, $data);

        $errors = $this->schemaErrors($code, $data, $prefix);
        if ($errors !== []) {
            throw ValidationException::withMessages($errors);
        }

        /** @var array<string, mixed> $array */
        $array = json_decode((string) json_encode($data, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES), true);

        $errors = $this->semanticErrors($code, $array, $prefix, $checkMedia);
        if ($errors !== []) {
            throw ValidationException::withMessages(array_slice($errors, 0, ThemeLimits::MAX_SCHEMA_ERRORS, true));
        }

        return $array;
    }

    /**
     * JSON Schema errors only (no semantic/media checks), keyed by dot path under $prefix. Used by the upgrader.
     *
     * @param  array<string, mixed>  $config
     * @return array<string, list<string>>
     */
    public function schemaErrorsFor(string $code, array $config, string $prefix = 'config'): array
    {
        return $this->schemaErrors($code, self::toObject($config), $prefix);
    }

    /** Byte size of the config as compact UTF-8 JSON (P3-16 cap). */
    public static function byteSize(mixed $config): int
    {
        return strlen((string) json_encode($config, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES));
    }

    /**
     * Arrays → objects for opis; keeps existing stdClass objects (and therefore `{}` vs `[]`) intact. An empty
     * PHP array under a `settings` key is an empty object (PHP decodes `{}` to `[]`).
     */
    public static function toObject(mixed $value, ?string $key = null): mixed
    {
        if ($value instanceof stdClass) {
            foreach (get_object_vars($value) as $k => $v) {
                $value->{$k} = self::toObject($v, (string) $k);
            }

            return $value;
        }
        if (is_array($value)) {
            if (($value !== [] && ! array_is_list($value)) || ($value === [] && $key === 'settings')) {
                $object = new stdClass;
                foreach ($value as $k => $v) {
                    $object->{$k} = self::toObject($v, (string) $k);
                }

                return $object;
            }

            return array_map(fn ($v) => self::toObject($v), $value);
        }

        return $value;
    }

    /**
     * Stage 2: trim every string (rich-text documents excepted: spaces between marks are content) and
     * lowercase colour values and media ids (ULIDs are case-insensitive; stored lowercase).
     */
    public static function normalise(mixed $value, ?string $key = null): mixed
    {
        if ($key === 'doc') {
            return $value;
        }
        if ($value instanceof stdClass) {
            foreach (get_object_vars($value) as $k => $v) {
                $value->{$k} = self::normalise($v, (string) $k);
            }

            return $value;
        }
        if (is_array($value)) {
            return array_map(fn ($v) => self::normalise($v), $value);
        }
        if (is_string($value)) {
            $value = trim($value);
            if ($key !== null && (str_ends_with($key, 'Color') || $key === 'customBackground' || str_ends_with($key, 'MediaId'))) {
                $value = strtolower($value);
            }
        }

        return $value;
    }

    private function assertTheme(string $code, stdClass $data): void
    {
        $theme = $data->theme ?? null;
        $version = is_string($data->version ?? null) ? $data->version : '';

        if ($theme !== $code || preg_match('/^\d+\.\d+\.\d+$/', $version) !== 1
            || ThemeRegistry::majorOf($version) !== $this->registry->major($code)) {
            throw new ApiException(422, 'theme_mismatch', 'This config is for a different theme or theme version.');
        }
    }

    /** @return array<string, list<string>> */
    private function schemaErrors(string $code, stdClass $data, string $prefix): array
    {
        $schema = json_decode($this->registry->schemaJson($code, $this->registry->major($code)), false);
        $result = $this->opis()->validate($data, $schema);

        if ($result->isValid()) {
            return [];
        }

        $errors = [];
        $this->collect($result->error(), $prefix, $errors);

        return array_slice($errors, 0, ThemeLimits::MAX_SCHEMA_ERRORS, true);
    }

    /** @param array<string, list<string>> $errors */
    private function collect(ValidationError $error, string $prefix, array &$errors): void
    {
        $subErrors = $error->subErrors();
        if ($subErrors !== []) {
            foreach ($subErrors as $sub) {
                $this->collect($sub, $prefix, $errors);
            }

            return;
        }

        $path = implode('.', array_map('strval', [$prefix, ...$error->data()->fullPath()]));
        $args = $error->args();

        $entries = match ($error->keyword()) {
            // opis (stopAtFirstError=false) also reports declared properties as "additional" when a sibling
            // property failed; keep only properties the schema really doesn't declare.
            'additionalProperties', 'unevaluatedProperties' => array_map(
                fn ($p) => ["{$path}.{$p}", 'Unknown field.'],
                self::undeclared($error, (array) ($args['properties'] ?? [])),
            ),
            'properties', 'dependencies' => isset($args['property'])
                ? [["{$path}.{$args['property']}", 'This field is not allowed here.']]
                : [[$path, self::message($error)]],
            'required' => array_map(fn ($p) => ["{$path}.{$p}", 'This field is required.'], (array) ($args['missing'] ?? [])),
            default => [[$path, self::message($error)]],
        };

        foreach ($entries as [$key, $message]) {
            $key ??= $path;
            if (! isset($errors[$key]) && count($errors) < ThemeLimits::MAX_SCHEMA_ERRORS) {
                $errors[$key] = [$message]; // first error per path (contract §3.1)
            }
        }
    }

    /**
     * @param  list<string>  $properties
     * @return list<string>
     */
    private static function undeclared(ValidationError $error, array $properties): array
    {
        $schema = $error->schema()->info()->data();
        $declared = is_object($schema) && isset($schema->properties) && is_object($schema->properties)
            ? array_keys(get_object_vars($schema->properties))
            : [];
        $patterns = is_object($schema) && isset($schema->patternProperties) && is_object($schema->patternProperties)
            ? array_keys(get_object_vars($schema->patternProperties))
            : [];

        return array_values(array_filter($properties, function ($p) use ($declared, $patterns) {
            if (in_array($p, $declared, true)) {
                return false;
            }
            foreach ($patterns as $pattern) {
                if (@preg_match('/'.str_replace('/', '\\/', $pattern).'/u', (string) $p) === 1) {
                    return false;
                }
            }

            return true;
        }));
    }

    private static function message(ValidationError $error): string
    {
        $message = $error->message();
        foreach ($error->args() as $name => $value) {
            $value = is_scalar($value) ? (string) $value : json_encode($value);
            $message = str_replace('{'.$name.'}', (string) $value, $message);
        }

        return $message;
    }

    /**
     * Stage 4: what the schema can't express.
     *
     * @param  array<string, mixed>  $config
     * @return array<string, list<string>>
     */
    private function semanticErrors(string $code, array $config, string $prefix, bool $checkMedia): array
    {
        $errors = [];
        $sections = is_array($config['sections'] ?? null) ? $config['sections'] : [];

        if (count($sections) > ThemeLimits::MAX_SECTIONS) {
            $errors["{$prefix}.sections"][] = 'A page can have at most '.ThemeLimits::MAX_SECTIONS.' sections.';
        }

        $ids = [];
        $counts = [];
        $limits = $this->registry->maxInstances($code);
        foreach ($sections as $i => $section) {
            $path = "{$prefix}.sections.{$i}";
            $this->uniqueId($section['id'] ?? null, "{$path}.id", $ids, $errors);

            $type = (string) ($section['type'] ?? '');
            $counts[$type] = ($counts[$type] ?? 0) + 1;
            if (isset($limits[$type]) && $counts[$type] > $limits[$type]) {
                $errors["{$path}.type"][] = "Only {$limits[$type]} of this section allowed.";
            }

            foreach (is_array($section['blocks'] ?? null) ? $section['blocks'] : [] as $j => $block) {
                $this->uniqueId($block['id'] ?? null, "{$path}.blocks.{$j}.id", $ids, $errors);
            }

            if (isset($section['settings']['doc'])) {
                foreach (RichTextValidator::validate($section['settings']['doc'], "{$path}.settings.doc", ThemeLimits::RICH_TEXT_SECTION_BYTES) as $k => $m) {
                    $errors[$k] = $m;
                }
            }
        }

        $mediaRefs = [];
        $this->walk($config, $prefix, $errors, $mediaRefs);

        if ($checkMedia && $mediaRefs !== []) {
            $valid = Media::query()
                ->whereIn('id', array_values(array_unique($mediaRefs)))
                ->whereIn('purpose', ThemeLimits::MEDIA_PURPOSES)
                ->where('status', '!=', Media::FAILED)
                ->pluck('id')->all();
            foreach ($mediaRefs as $path => $id) {
                if (! in_array($id, $valid, true)) {
                    $errors[$path] = ['Unknown image.'];
                }
            }
        }

        return $errors;
    }

    /**
     * Hrefs, colours, fonts and media ids anywhere in the document (rich-text docs are checked separately).
     *
     * @param  array<string, list<string>>  $errors
     * @param  array<string, string>  $mediaRefs  path => id
     */
    private function walk(mixed $node, string $path, array &$errors, array &$mediaRefs): void
    {
        if (! is_array($node)) {
            return;
        }

        foreach ($node as $key => $value) {
            $p = "{$path}.{$key}";
            $key = (string) $key;

            if ($key === 'doc') {
                continue;
            }
            if (is_array($value)) {
                $this->walk($value, $p, $errors, $mediaRefs);

                continue;
            }
            if ($value === null) {
                continue;
            }

            if ($key === 'href' || str_ends_with($key, 'Href')) {
                if (! SafeHref::theme($value)) {
                    $errors[$p] = ['This link is not allowed.'];
                }
            } elseif (str_ends_with($key, 'MediaId')) {
                if (! is_string($value) || preg_match('/^[0-9a-z]{26}$/', $value) !== 1) {
                    $errors[$p] = ['Unknown image.'];
                } else {
                    $mediaRefs[$p] = $value;
                }
            } elseif (str_ends_with($key, 'Color') || $key === 'customBackground') {
                if (! is_string($value) || preg_match('/^#[0-9a-f]{6}$/', $value) !== 1) {
                    $errors[$p] = ['Must be a colour like #1a2b3c.'];
                }
            } elseif ($key === 'fontFamily' || str_ends_with($key, 'FontFamily')) {
                if (! in_array($value, $this->registry->fonts(), true)) {
                    $errors[$p] = ['This font is not available.'];
                }
            }
        }
    }

    /**
     * @param  array<string, true>  $ids
     * @param  array<string, list<string>>  $errors
     */
    private function uniqueId(mixed $id, string $path, array &$ids, array &$errors): void
    {
        if (! is_string($id)) {
            return; // the schema reports missing/invalid ids
        }
        if (isset($ids[$id])) {
            $errors[$path][] = 'Ids must be unique within the theme.';
        }
        $ids[$id] = true;
    }

    private function opis(): Validator
    {
        if ($this->opis === null) {
            $this->opis = new Validator;
            $this->opis->setMaxErrors(ThemeLimits::MAX_SCHEMA_ERRORS);
            $this->opis->setStopAtFirstError(false);
        }

        return $this->opis;
    }

    /**
     * Collect every `*MediaId` value of a config (for media maps).
     *
     * @return list<string>
     */
    public static function mediaIds(mixed $config): array
    {
        $ids = [];
        $walk = function (mixed $node) use (&$walk, &$ids): void {
            if (! is_array($node)) {
                return;
            }
            foreach ($node as $key => $value) {
                if (is_array($value)) {
                    $walk($value);
                } elseif (is_string($value) && str_ends_with((string) $key, 'MediaId')) {
                    $ids[] = $value;
                }
            }
        };
        $walk($config);

        return array_values(array_unique($ids));
    }
}
