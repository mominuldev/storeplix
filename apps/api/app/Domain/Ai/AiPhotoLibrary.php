<?php

declare(strict_types=1);

namespace App\Domain\Ai;

use App\Domain\Ai\Models\AiGeneration;
use App\Domain\Ai\Photos\PhotoResult;
use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\Models\ProductImage;
use App\Domain\Catalog\Models\ProductVariant;
use App\Domain\Developer\Webhooks\WebhookEvents;
use App\Domain\Developer\Webhooks\WebhookEventType;
use App\Domain\Feeds\FeedHooks;
use App\Domain\Identity\Models\User;
use App\Domain\Media\Jobs\ProcessMedia;
use App\Domain\Media\MediaPurpose;
use App\Domain\Media\Models\Media;
use App\Domain\Media\TenantStorage;
use App\Domain\Pages\Models\StorePage;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Themes\Models\StoreTheme;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\URL;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

/**
 * AI photo results and their lifecycle (PHASE-8-9D P89D-58, S346). A result is a private `ai_photo` media row on the
 * private disk under the tenant prefix, opened only through a signed link, until "Save to product" (`apply`) moves it
 * to the media disk as a normal `product_image` (variants rendered by ProcessMedia) and puts it in place of the chosen
 * image (same position, variant pictures follow) or at the end. The replaced original is kept 30 days for Undo; undo
 * swaps it back (or removes an appended result). No credit is refunded on undo (P89D-56).
 */
final class AiPhotoLibrary
{
    public const DOWNLOAD_ROUTE = 'ai-photos.download';

    public function __construct(
        private readonly TenantStorage $storage,
        private readonly AuditLogger $audit,
    ) {}

    public function storeResult(PhotoResult $result, ?string $userId): Media
    {
        $id = strtolower((string) Str::ulid());
        $disk = $this->storage->privateDiskName();
        $path = $this->storage->path($id, 'result.'.MediaPurpose::extensionFor($result->mime));
        $this->storage->disk($disk)->put($path, $result->bytes);
        $media = new Media;
        $media->id = $id;
        $media->forceFill([
            'purpose' => MediaPurpose::AiPhoto->value, 'disk' => $disk, 'path' => $path, 'mime' => $result->mime,
            'size_bytes' => strlen($result->bytes), 'width' => $result->width, 'height' => $result->height,
            'checksum' => hash('sha256', $result->bytes), 'status' => Media::READY, 'variants' => [], 'uploaded_by' => $userId,
        ])->save();

        return $media;
    }

    public function deleteMedia(Media $media): void
    {
        $this->storage->disk($media->disk)->deleteDirectory('tenants/'.$media->tenant_id.'/media/'.$media->id);
        DB::transaction(fn () => $media->delete());
    }

    /** Signed link to a private result (30 minutes, tenant in the signature). */
    public static function link(Media $media): string
    {
        return URL::temporarySignedRoute(self::DOWNLOAD_ROUTE, now()->addMinutes((int) config('ai.result_link_minutes', 30)), ['media' => $media->id, 'tenant' => $media->tenant_id]);
    }

    /** POST …/photo-edits/{generation}/apply (§11.3). */
    public function apply(Store $store, AiGeneration $generation, string $productId, ?string $replaceImageId, User $user): AiGeneration
    {
        $result = DB::transaction(function () use ($store, $generation, $productId, $replaceImageId, $user) {
            /** @var AiGeneration $g */
            $g = AiGeneration::query()->where('store_id', $store->id)->whereKey($generation->id)->lockForUpdate()->firstOrFail();
            $media = $g->result_media_id !== null ? Media::query()->whereKey($g->result_media_id)->lockForUpdate()->first() : null;
            if ($g->kind !== AiGeneration::PHOTO || $g->status !== AiGeneration::SUCCEEDED || $media === null || $media->purpose !== MediaPurpose::AiPhoto->value) {
                throw self::notApplicable();
            }
            /** @var Product|null $product */
            $product = Product::query()->where('store_id', $store->id)->whereKey(strtolower($productId))->lockForUpdate()->first();
            if ($product === null) {
                throw new ApiException(404, 'not_found', 'Resource not found.');
            }
            $original = null;
            if ($replaceImageId !== null) {
                $replaceImageId = strtolower($replaceImageId);
                $original = ProductImage::query()->where('product_id', $product->id)
                    ->where(fn ($q) => $q->where('media_id', $replaceImageId)->orWhere('id', $replaceImageId))->first();
                if ($original === null) {
                    throw ValidationException::withMessages(['replace_image_id' => ['Choose a photo of this product.']]);
                }
            }

            // Private ai_photo → public product_image (same tenant prefix), variants rendered after commit.
            $publicDisk = $this->storage->diskName();
            if ($media->disk !== $publicDisk) {
                $bytes = (string) $this->storage->disk($media->disk)->get($media->path);
                $this->storage->disk($publicDisk)->put($media->path, $bytes);
                $this->storage->disk($media->disk)->delete($media->path);
            }
            $media->forceFill(['purpose' => MediaPurpose::ProductImage->value, 'disk' => $publicDisk, 'status' => Media::PROCESSING])->save();
            ProcessMedia::dispatch($media->id)->afterCommit();

            $originalId = null;
            if ($original !== null) {
                $originalId = $original->media_id;
                $original->media_id = $media->id;
                $original->save();
                ProductVariant::query()->where('product_id', $product->id)->where('image_media_id', $originalId)->update(['image_media_id' => $media->id]);
            } else {
                $row = new ProductImage(['media_id' => $media->id]);
                $row->store_id = $product->store_id;
                $row->product_id = $product->id;
                $row->position = (int) ProductImage::query()->where('product_id', $product->id)->max('position') + 1;
                $row->save();
            }
            $this->touchProduct($product, $user);

            $g->forceFill([
                'status' => AiGeneration::APPLIED,
                'product_id' => $product->id,
                'original_media_id' => $originalId,
                'applied_at' => now(),
                'original_kept_until' => $originalId !== null ? now()->addDays((int) config('ai.retention.originals', 30)) : null,
            ])->save();
            $this->audit->log('ai.photo_applied', $g, ['store_id' => $store->id, 'product_id' => $product->id, 'media_id' => $media->id, 'replaced_media_id' => $originalId], $user);

            return $g;
        });

        return $result->refresh();
    }

    /** POST …/photo-edits/{generation}/undo (§11.3): applied → undone while the original is kept. */
    public function undo(Store $store, AiGeneration $generation, User $user): AiGeneration
    {
        return DB::transaction(function () use ($store, $generation, $user) {
            /** @var AiGeneration $g */
            $g = AiGeneration::query()->where('store_id', $store->id)->whereKey($generation->id)->lockForUpdate()->firstOrFail();
            if ($g->kind !== AiGeneration::PHOTO || $g->status !== AiGeneration::APPLIED || $g->product_id === null || $g->result_media_id === null) {
                throw self::notApplicable();
            }
            $product = Product::query()->where('store_id', $store->id)->whereKey($g->product_id)->lockForUpdate()->first();
            $row = $product !== null ? ProductImage::query()->where('product_id', $product->id)->where('media_id', $g->result_media_id)->first() : null;
            if ($product === null || $row === null) {
                throw self::notApplicable();
            }
            if ($g->original_media_id !== null) {
                $kept = $g->original_kept_until !== null && $g->original_kept_until->isFuture()
                    && Media::query()->whereKey($g->original_media_id)->where('status', '<>', Media::FAILED)->exists();
                if (! $kept || ProductImage::query()->where('product_id', $product->id)->where('media_id', $g->original_media_id)->exists()) {
                    throw self::notApplicable();
                }
                $row->media_id = $g->original_media_id;
                $row->save();
                ProductVariant::query()->where('product_id', $product->id)->where('image_media_id', $g->result_media_id)->update(['image_media_id' => $g->original_media_id]);
            } else {
                $row->delete();
                ProductVariant::query()->where('product_id', $product->id)->where('image_media_id', $g->result_media_id)->update(['image_media_id' => null]);
            }
            $this->touchProduct($product, $user);
            $g->forceFill(['status' => AiGeneration::UNDONE, 'undone_at' => now()])->save();
            $this->audit->log('ai.photo_undone', $g, ['store_id' => $store->id, 'product_id' => $product->id, 'restored_media_id' => $g->original_media_id], $user);

            return $g;
        })->refresh();
    }

    /** True when the media is still used anywhere in the shop (product, variant, settings, page or theme). */
    public static function inUse(string $mediaId): bool
    {
        $like = '%"'.$mediaId.'"%';

        return ProductImage::query()->where('media_id', $mediaId)->exists()
            || ProductVariant::withTrashed()->where('image_media_id', $mediaId)->exists()
            || StoreSetting::query()->where(fn ($q) => $q->where('logo_media_id', $mediaId)->orWhere('favicon_media_id', $mediaId)->orWhere('og_image_media_id', $mediaId))->exists()
            || StorePage::query()->where(fn ($q) => $q->where('og_image_media_id', $mediaId)->orWhereRaw('CAST(body AS TEXT) LIKE ?', [$like]))->exists()
            || StoreTheme::query()->where(fn ($q) => $q->whereRaw('CAST(draft_config AS TEXT) LIKE ?', [$like])->orWhereRaw('CAST(published_config AS TEXT) LIKE ?', [$like]))->exists()
            || DB::table('categories')->where('image_media_id', $mediaId)->exists()
            || AiGeneration::query()->whereIn('status', [AiGeneration::QUEUED, AiGeneration::RUNNING, AiGeneration::SUCCEEDED])->where('source_media_id', $mediaId)->exists();
    }

    private function touchProduct(Product $product, User $user): void
    {
        $product->revision++;
        $product->updated_by = $user->getKey();
        $product->save();
        WebhookEvents::emit(WebhookEventType::ProductUpdated, $product);
        FeedHooks::product($product->store_id, $product->id);
    }

    private static function notApplicable(): ApiException
    {
        return new ApiException(409, 'ai_generation_not_applicable', 'This photo edit can’t be saved or undone any more.');
    }
}
