<?php

declare(strict_types=1);

namespace App\Domain\Ai;

use App\Domain\Ai\Credits\AiCreditCharger;
use App\Domain\Ai\Models\AiGeneration;
use App\Domain\Ai\Photos\PhotoEditor;
use App\Domain\Ai\Writer\AnthropicDescriptionWriter;
use App\Domain\Ai\Writer\DescriptionOutput;
use App\Domain\Ai\Writer\DescriptionRequest;
use App\Domain\Ai\Writer\FakeDescriptionWriter;
use App\Domain\Ai\Writer\ProductDescriptionWriter;
use App\Domain\Catalog\Models\Category;
use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\Models\ProductImage;
use App\Domain\Identity\Models\User;
use App\Domain\Media\Models\Media;
use App\Domain\Media\TenantStorage;
use App\Domain\Tenancy\Support\AuditLogger;
use GdImage;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * The work of the `ai` queue jobs (PHASE-8-9D §11): claim `queued → running` with a conditional UPDATE (a replayed job
 * does nothing), call the driver OUTSIDE any transaction and lock, then write the result. Every failure ends the
 * generation `failed` with an AiErrorCode and refunds its credits once (P89D-56). Logs carry ids and codes only.
 */
final class AiRunner
{
    public function __construct(
        private readonly AiCreditCharger $credits,
        private readonly AuditLogger $audit,
        private readonly TenantStorage $storage,
        private readonly AiPhotoLibrary $photos,
    ) {}

    public static function writer(): ProductDescriptionWriter
    {
        return config('ai.driver') === 'anthropic' ? app(AnthropicDescriptionWriter::class) : app(FakeDescriptionWriter::class);
    }

    public function describe(string $generationId): void
    {
        $g = $this->claim($generationId, AiGeneration::DESCRIPTION);
        if ($g === null) {
            return;
        }
        try {
            $input = (array) $g->input;
            $request = $this->descriptionRequest($g, $input);
            $writer = self::writer();
            $result = $writer->write($request);
            $variants = DescriptionOutput::build($result->variants, (int) ($input['variants'] ?? 2));
        } catch (AiException $e) {
            $this->fail($g, $e->errorCode);

            return;
        } catch (Throwable $e) {
            report($e);
            $this->fail($g, AiException::PROVIDER_ERROR);

            return;
        }
        $moved = AiGeneration::query()->whereKey($g->id)->where('status', AiGeneration::RUNNING)->update([
            'status' => AiGeneration::SUCCEEDED,
            'output' => json_encode(['variants' => $variants], JSON_UNESCAPED_UNICODE),
            'model' => $result->model !== null ? mb_substr($result->model, 0, 64) : null,
            'usage' => json_encode($result->usage),
            'finished_at' => now(),
            'updated_at' => now(),
        ]);
        if ($moved === 1) {
            $actor = $g->requested_by !== null ? User::query()->find($g->requested_by) : null;
            $this->audit->log('ai.description_generated', $g, [
                'store_id' => $g->store_id, 'product_id' => $g->product_id, 'language' => $input['language'] ?? null, 'variants' => count($variants),
            ], $actor, system: $actor === null);
        }
    }

    public function editPhoto(string $generationId): void
    {
        $g = $this->claim($generationId, AiGeneration::PHOTO);
        if ($g === null) {
            return;
        }
        try {
            $source = $g->source_media_id !== null ? Media::query()->find($g->source_media_id) : null;
            $bytes = $source !== null && $this->storage->ownsPath($source->path) ? $this->storage->disk($source->disk)->get($source->path) : null;
            if ($source === null || ! is_string($bytes) || $bytes === '') {
                throw new AiException(AiException::IMAGE_UNSUPPORTED, 'The source photo is gone.');
            }
            $input = (array) $g->input;
            $result = app(PhotoEditor::class)->edit($bytes, $source->mime, (string) $input['operation'], (string) ($input['background'] ?? 'studio_white'), $g->id);
            $media = $this->photos->storeResult($result, $g->requested_by);
        } catch (AiException $e) {
            $this->fail($g, $e->errorCode);

            return;
        } catch (Throwable $e) {
            report($e);
            $this->fail($g, AiException::PROVIDER_ERROR);

            return;
        }
        $moved = AiGeneration::query()->whereKey($g->id)->where('status', AiGeneration::RUNNING)->update([
            'status' => AiGeneration::SUCCEEDED,
            'result_media_id' => $media->id,
            'flags' => json_encode(['check_edges' => $result->checkEdges]),
            'finished_at' => now(),
            'updated_at' => now(),
        ]);
        if ($moved !== 1) {
            $this->photos->deleteMedia($media);
        }
    }

    /** A generation whose job died: failed (`provider_error`) + refund, unless it already finished. */
    public function abandon(string $generationId): void
    {
        $g = AiGeneration::query()->find($generationId);
        if ($g !== null && ! $g->isFinal()) {
            $this->fail($g, AiException::PROVIDER_ERROR);
        }
    }

    /** queued → running, once. Null when the row is gone, of another kind, or already claimed. */
    private function claim(string $id, string $kind): ?AiGeneration
    {
        $moved = AiGeneration::query()->whereKey($id)->where('kind', $kind)->where('status', AiGeneration::QUEUED)
            ->update(['status' => AiGeneration::RUNNING, 'updated_at' => now()]);

        return $moved === 1 ? AiGeneration::query()->find($id) : null;
    }

    private function fail(AiGeneration $g, string $code): void
    {
        Log::warning('ai.generation_failed', ['generation_id' => $g->id, 'kind' => $g->kind, 'code' => $code]);
        DB::transaction(function () use ($g, $code) {
            $moved = AiGeneration::query()->whereKey($g->id)->whereIn('status', [AiGeneration::QUEUED, AiGeneration::RUNNING])->update([
                'status' => AiGeneration::FAILED,
                'error_code' => in_array($code, AiGeneration::ERROR_CODES, true) ? $code : AiException::PROVIDER_ERROR,
                'finished_at' => now(),
                'updated_at' => now(),
            ]);
            if ($moved === 1) {
                $this->credits->refund($g);
            }
        });
    }

    /** @param array<string, mixed> $input */
    private function descriptionRequest(AiGeneration $g, array $input): DescriptionRequest
    {
        $product = $g->product_id !== null ? Product::query()->where('store_id', $g->store_id)->find($g->product_id) : null;
        $category = $input['category'] ?? null;
        if ($category === null && $product !== null) {
            $category = Category::query()->where('store_id', $g->store_id)
                ->whereIn('id', DB::table('product_categories')->where('product_id', $product->id)->select('category_id'))->orderBy('name')->value('name');
        }
        $options = [];
        foreach ((array) ($product?->options ?? []) as $option) {
            if (is_array($option) && is_string($option['name'] ?? null)) {
                $options[] = ['name' => mb_substr($option['name'], 0, 60), 'values' => array_values(array_map(fn ($v) => mb_substr((string) $v, 0, 60), array_slice((array) ($option['values'] ?? []), 0, 30)))];
            }
        }
        $image = null;
        if (($input['use_product_image'] ?? false) && $product !== null) {
            $mediaId = ProductImage::query()->where('product_id', $product->id)->orderBy('position')->value('media_id');
            $media = $mediaId !== null ? Media::query()->find($mediaId) : null;
            $image = $media !== null ? $this->modelImage($media) : null;
        }

        return new DescriptionRequest(
            (string) $input['name'],
            is_string($category) ? mb_substr($category, 0, 100) : null,
            $options,
            array_values(array_map('strval', (array) ($input['key_points'] ?? []))),
            (string) ($input['language'] ?? 'bn'),
            (string) ($input['tone'] ?? 'friendly'),
            (string) ($input['length'] ?? 'medium'),
            max(1, min(3, (int) ($input['variants'] ?? 2))),
            $image,
        );
    }

    /**
     * P89D-38: the main image re-encoded as JPEG, longest side ≤ 1,568 px, base64. Null when unreadable (the request
     * then goes without an image rather than failing).
     *
     * @return array{media_type: string, data: string}|null
     */
    private function modelImage(Media $media): ?array
    {
        if ($media->status !== Media::READY || ! $this->storage->ownsPath($media->path)) {
            return null;
        }
        $bytes = $this->storage->disk($media->disk)->get($media->path);
        $image = is_string($bytes) ? @imagecreatefromstring($bytes) : false;
        if (! $image instanceof GdImage) {
            return null;
        }
        [$w, $h] = [imagesx($image), imagesy($image)];
        $max = (int) config('ai.text.image_max_side', 1568);
        $scale = min(1, $max / max($w, $h));
        $tw = max(1, (int) round($w * $scale));
        $th = max(1, (int) round($h * $scale));
        $canvas = imagecreatetruecolor($tw, $th);
        imagefill($canvas, 0, 0, imagecolorallocate($canvas, 255, 255, 255));
        imagecopyresampled($canvas, $image, 0, 0, 0, 0, $tw, $th, $w, $h);
        ob_start();
        imagejpeg($canvas, null, 85);
        $jpeg = (string) ob_get_clean();
        imagedestroy($image);
        imagedestroy($canvas);

        return $jpeg === '' ? null : ['media_type' => 'image/jpeg', 'data' => base64_encode($jpeg)];
    }
}
