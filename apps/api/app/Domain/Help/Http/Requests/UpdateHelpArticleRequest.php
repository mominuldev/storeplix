<?php

declare(strict_types=1);

namespace App\Domain\Help\Http\Requests;

use App\Domain\Help\HelpArticleDocValidator;
use App\Domain\Help\HelpDb;
use App\Domain\Help\Models\HelpMedia;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Validation\Validator;

/**
 * PATCH /admin/help-articles/{article} (PHASE-8-9C §7.1): draft fields only. Bodies are validated by
 * HelpArticleDocValidator (errors keyed `translations.en.body.content.3…`); image ids must name an existing help image.
 */
class UpdateHelpArticleRequest extends FormRequest
{
    public const SLUG = 'regex:/^[a-z0-9]+(?:-[a-z0-9]+)*$/';

    public function authorize(): bool
    {
        return true;
    }

    /** @return array<string, mixed> */
    public function rules(): array
    {
        $rules = [
            'revision' => ['required', 'integer', 'min:1'],
            'slug' => ['sometimes', 'string', 'max:80', self::SLUG],
            'category_id' => ['sometimes', 'string', 'size:26'],
            'related_article_ids' => ['sometimes', 'array', 'max:5'],
            'related_article_ids.*' => ['string', 'size:26'],
            'translations' => ['sometimes', 'array:en,bn'],
            'translations.en' => ['sometimes', 'array'],
            'translations.bn' => ['sometimes', 'nullable', 'array'],
        ];
        foreach (['en', 'bn'] as $l) {
            $rules += self::translationRules("translations.{$l}");
        }

        return $rules;
    }

    /** @return array<string, list<string>> */
    public static function translationRules(string $prefix): array
    {
        return [
            "{$prefix}.title" => ['sometimes', 'nullable', 'string', 'max:120'],
            "{$prefix}.summary" => ['sometimes', 'nullable', 'string', 'max:160'],
            "{$prefix}.body" => ['required_with:'.$prefix],
            "{$prefix}.keywords" => ['sometimes', 'nullable', 'array', 'max:12'],
            "{$prefix}.keywords.*" => ['string', 'max:40'],
        ];
    }

    public function after(): array
    {
        return [function (Validator $v): void {
            foreach (['en', 'bn'] as $l) {
                $t = $this->input("translations.{$l}");
                if (! is_array($t) || ! array_key_exists('body', $t)) {
                    continue;
                }
                $known = fn (string $id): bool => HelpDb::query(HelpMedia::class)->whereKey($id)->where('status', '<>', HelpMedia::FAILED)->exists();
                foreach (HelpArticleDocValidator::validate($t['body'], "translations.{$l}.body", $known) as $key => $messages) {
                    foreach ($messages as $message) {
                        $v->errors()->add($key, $message);
                    }
                }
            }
            if ($this->has('translations.en') && $this->input('translations.en') === null) {
                $v->errors()->add('translations.en', 'The English translation is required.');
            }
        }];
    }
}
