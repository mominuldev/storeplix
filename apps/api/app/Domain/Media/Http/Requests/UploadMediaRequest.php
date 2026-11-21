<?php

namespace App\Domain\Media\Http\Requests;

use App\Domain\Media\ImageInspector;
use App\Domain\Media\MediaPurpose;
use Illuminate\Foundation\Http\FormRequest;
use Illuminate\Http\UploadedFile;
use Illuminate\Validation\Rule;
use Illuminate\Validation\Validator;

class UploadMediaRequest extends FormRequest
{
    /** @var array{mime: string, width: int, height: int}|null */
    public ?array $inspected = null;

    public function authorize(): bool
    {
        return true; // all roles (ADR 0005: catalog/media operations)
    }

    public function rules(): array
    {
        return [
            'file' => ['required', 'file'],
            'purpose' => ['required', 'string', Rule::enum(MediaPurpose::class)],
            'alt' => ['sometimes', 'nullable', 'string', 'max:255'],
        ];
    }

    public function after(): array
    {
        return [function (Validator $validator) {
            if ($validator->errors()->isNotEmpty()) {
                return;
            }

            /** @var UploadedFile $file */
            $file = $this->file('file');
            $purpose = MediaPurpose::from($this->input('purpose'));

            if ($file->getSize() > $purpose->maxBytes()) {
                $validator->errors()->add('file', sprintf('The file may not be larger than %d MB.', $purpose->maxBytes() / 1024 / 1024));

                return;
            }

            // MIME from the bytes only — the extension and client Content-Type are ignored.
            $info = ImageInspector::inspect($file->getRealPath());
            if ($info === null || ! in_array($info['mime'], $purpose->mimes(), true) || $info['width'] === 0) {
                $allowed = implode(', ', array_map(fn ($m) => strtoupper(substr($m, 6)), $purpose->mimes()));
                $validator->errors()->add('file', "Unsupported file type. Allowed: {$allowed}.");

                return;
            }

            [$w, $h] = [$info['width'], $info['height']];
            [$min, $max] = $purpose->sideBounds();

            if ($w * $h > MediaPurpose::MAX_PIXELS) {
                $validator->errors()->add('file', 'The image is too large (max 40 megapixels).');
            } elseif ($w < $min || $h < $min || $w > $max || $h > $max) {
                $validator->errors()->add('file', "Each side must be between {$min} and {$max} px.");
            } elseif ($purpose->mustBeSquare() && abs($w - $h) > 1) {
                $validator->errors()->add('file', 'The favicon must be square.');
            } else {
                $this->inspected = $info;
            }
        }];
    }
}
