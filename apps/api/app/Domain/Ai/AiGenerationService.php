<?php

declare(strict_types=1);

namespace App\Domain\Ai;

use App\Domain\Ai\Credits\AiCreditCharger;
use App\Domain\Ai\Jobs\EditProductPhoto;
use App\Domain\Ai\Jobs\GenerateProductDescription;
use App\Domain\Ai\Models\AiGeneration;
use App\Domain\Ai\Photos\PhotoEditor;
use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\Models\ProductImage;
use App\Domain\Identity\Models\User;
use App\Domain\Integrations\IntegrationProvider;
use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Integrations\Settings\AiPhotosSettings;
use App\Domain\Integrations\Settings\AiWriterSettings;
use App\Domain\Media\MediaPurpose;
use App\Domain\Media\Models\Media;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Validator;
use Illuminate\Support\Str;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;

/**
 * PHASE-8-9D §11.2 / §11.3: creating AI generations. Order of checks: replay by Idempotency-Key (same key + same body →
 * the same generation; another body → 409 `idempotency_key_mismatch`), the tool is On (409 `ai_integration_off`), the
 * input (422), ids in the body resolved within the store (404, S330), then ONE transaction that charges the credits
 * (402 `ai_credits_exhausted`) and inserts the `queued` generation (P89D-34). The job is dispatched after commit on queue
 * `ai`; no provider is called inside a request. AI output is never written to a product here (P89D-52).
 */
final class AiGenerationService
{
    public const QUEUE = 'ai';

    public function __construct(private readonly AiCreditCharger $credits) {}

    /** @param array<string, mixed> $body */
    public function describe(Store $store, array $body, User $user, string $key): AiGeneration
    {
        $hash = self::hash($body);
        if ($replay = $this->replay($store, $user, $key, $hash)) {
            return $replay;
        }
        $settings = $this->requireOn($store, IntegrationProvider::AI_WRITER);
        $defaults = array_replace(AiWriterSettings::defaults(), $settings);
        $input = Validator::make($body, [
            'product_id' => ['sometimes', 'nullable', 'string', 'size:26'],
            'name' => ['sometimes', 'nullable', 'string', 'max:200', 'required_without:product_id'],
            'category' => ['sometimes', 'nullable', 'string', 'max:100'],
            'key_points' => ['sometimes', 'array', 'max:10'],
            'key_points.*' => ['string', 'max:200'],
            'language' => ['sometimes', 'string', 'in:bn,en'],
            'tone' => ['sometimes', 'string', 'in:friendly,professional,playful,premium'],
            'length' => ['sometimes', 'string', 'in:short,medium,long'],
            'variants' => ['sometimes', 'integer', 'between:1,3'],
            'use_product_image' => ['sometimes', 'boolean:strict'],
        ])->validate();
        $product = null;
        if (($input['product_id'] ?? null) !== null) {
            $product = Product::query()->where('store_id', $store->id)->whereKey(strtolower((string) $input['product_id']))->first()
                ?? throw new ApiException(404, 'not_found', 'Resource not found.');
        }
        $name = trim((string) ($input['name'] ?? ''));
        $normalized = [
            'product_id' => $product?->id,
            'name' => $name !== '' ? $name : ($product?->name ?? ''),
            'category' => isset($input['category']) && trim((string) $input['category']) !== '' ? trim((string) $input['category']) : null,
            'key_points' => array_values(array_filter(array_map(fn ($p) => trim((string) $p), (array) ($input['key_points'] ?? [])), fn ($p) => $p !== '')),
            'language' => (string) ($input['language'] ?? $defaults['default_language']),
            'tone' => (string) ($input['tone'] ?? $defaults['default_tone']),
            'length' => (string) ($input['length'] ?? $defaults['default_length']),
            'variants' => (int) ($input['variants'] ?? 2),
            'use_product_image' => (bool) ($input['use_product_image'] ?? $defaults['use_product_image']),
        ];
        if ($normalized['name'] === '') {
            throw ValidationException::withMessages(['name' => ['Enter the product name.']]);
        }

        return $this->create($store, $user, $key, $hash, AiGeneration::DESCRIPTION, $normalized, $product?->id, null, $this->writerProvider());
    }

    /** @param array<string, mixed> $body */
    public function editPhoto(Store $store, array $body, User $user, string $key): AiGeneration
    {
        $hash = self::hash($body);
        if ($replay = $this->replay($store, $user, $key, $hash)) {
            return $replay;
        }
        $settings = $this->requireOn($store, IntegrationProvider::AI_PHOTOS);
        if (! self::photosAvailable()) {
            throw new ApiException(409, 'ai_integration_off', 'AI product photos are coming soon.');
        }
        $input = Validator::make($body, [
            'media_id' => ['required', 'string', 'size:26'],
            'product_id' => ['sometimes', 'nullable', 'string', 'size:26'],
            'operation' => ['required', 'string', 'in:remove_background,replace_background'],
            'background' => ['nullable', 'required_if:operation,replace_background', 'string', Rule::in(AiPhotosSettings::BACKGROUNDS)],
        ])->validate();
        $mediaId = strtolower((string) $input['media_id']);
        $productId = isset($input['product_id']) ? strtolower((string) $input['product_id']) : null;
        // S346: the source must be a product image of THIS store (and of the named product).
        $image = ProductImage::query()->where('store_id', $store->id)->where('media_id', $mediaId)
            ->when($productId !== null, fn ($q) => $q->where('product_id', $productId))->orderBy('position')->first();
        $media = $image !== null ? Media::query()->whereKey($mediaId)->where('purpose', MediaPurpose::ProductImage->value)->first() : null;
        if ($image === null || $media === null) {
            throw new ApiException(404, 'not_found', 'Resource not found.');
        }
        if ($media->status !== Media::READY || ! in_array($media->mime, ['image/jpeg', 'image/png', 'image/webp'], true)
            || $media->size_bytes > MediaPurpose::AiPhoto->maxBytes() || min($media->width, $media->height) < 300) {
            throw new ApiException(422, 'image_unsupported', 'Use a JPG, PNG or WebP product photo of at least 300 × 300 px and at most 10 MB.',
                ['media_id' => ['This photo can’t be edited.']]);
        }
        $operation = (string) $input['operation'];
        $normalized = [
            'media_id' => $mediaId,
            'product_id' => $image->product_id,
            'operation' => $operation,
            'background' => $operation === 'remove_background' ? 'transparent' : (string) ($input['background'] ?? $settings['default_background'] ?? 'studio_white'),
        ];

        return $this->create($store, $user, $key, $hash, AiGeneration::PHOTO, $normalized, $image->product_id, $mediaId, app(PhotoEditor::class)->provider());
    }

    /** P89D-39: a photo driver is usable — the fake outside production only (a real driver is chosen later, Q358). */
    public static function photosAvailable(): bool
    {
        return config('ai.image_driver') === 'fake' && ! app()->environment('production');
    }

    /** @param array<string, mixed> $input */
    private function create(Store $store, User $user, string $key, string $hash, string $kind, array $input, ?string $productId, ?string $sourceMediaId, string $provider): AiGeneration
    {
        $cost = AiCreditCharger::cost($kind);
        try {
            $generation = DB::transaction(function () use ($store, $user, $key, $hash, $kind, $input, $productId, $sourceMediaId, $provider, $cost) {
                $g = new AiGeneration;
                $g->forceFill([
                    'store_id' => $store->id,
                    'kind' => $kind,
                    'status' => AiGeneration::QUEUED,
                    'product_id' => $productId,
                    'source_media_id' => $sourceMediaId,
                    'input' => $input,
                    'credits' => $cost,
                    'provider' => $provider,
                    'model' => $kind === AiGeneration::DESCRIPTION && $provider === 'anthropic' ? (string) config('ai.text.model') : null,
                    'flags' => [],
                    'requested_by' => $user->id,
                    'idempotency_key' => $key,
                    'request_hash' => $hash,
                ]);
                $g->id = strtolower((string) Str::ulid());
                $g->save();
                $g->charged_from = $this->credits->charge($g, $cost, $user);
                $g->save();

                return $g;
            });
        } catch (UniqueConstraintViolationException) {
            // A concurrent request with the same key won: answer with its generation.
            return $this->replay($store, $user, $key, $hash) ?? throw new ApiException(409, 'idempotency_key_mismatch', 'This Idempotency-Key is already in use.');
        }
        $job = $kind === AiGeneration::DESCRIPTION ? new GenerateProductDescription($generation->id) : new EditProductPhoto($generation->id);
        dispatch($job->forTenant($generation->tenant_id)->onQueue(self::QUEUE));

        return $generation->refresh();
    }

    private function replay(Store $store, User $user, string $key, string $hash): ?AiGeneration
    {
        $existing = AiGeneration::query()->where('store_id', $store->id)->where('requested_by', $user->id)->where('idempotency_key', $key)->first();
        if ($existing !== null && ! hash_equals($existing->request_hash, $hash)) {
            throw new ApiException(409, 'idempotency_key_mismatch', 'This Idempotency-Key was used for a different request.');
        }

        return $existing;
    }

    /** @return array<string, mixed> the tool's saved settings; 409 `ai_integration_off` unless On (P89D-54). */
    private function requireOn(Store $store, string $provider): array
    {
        $row = StoreIntegration::query()->where('store_id', $store->id)->where('provider', $provider)->first();
        if ($row === null || ! in_array($row->status, StoreIntegration::ACTIVE, true)) {
            throw new ApiException(409, 'ai_integration_off', 'Turn on '.(IntegrationProvider::LABELS[$provider] ?? 'this AI tool').' in Integrations first.');
        }

        return (array) $row->settings;
    }

    private function writerProvider(): string
    {
        return config('ai.driver') === 'anthropic' ? 'anthropic' : 'fake';
    }

    /** @param array<string, mixed> $body */
    public static function hash(array $body): string
    {
        $sort = function (array $a) use (&$sort): array {
            if (! array_is_list($a)) {
                ksort($a);
            }

            return array_map(fn ($v) => is_array($v) ? $sort($v) : $v, $a);
        };

        return hash('sha256', (string) json_encode($sort($body), JSON_UNESCAPED_UNICODE));
    }
}
