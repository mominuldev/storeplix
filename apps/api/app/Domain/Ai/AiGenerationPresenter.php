<?php

declare(strict_types=1);

namespace App\Domain\Ai;

use App\Domain\Ai\Models\AiGeneration;
use App\Domain\Media\MediaMaps;
use App\Domain\Media\MediaPurpose;
use App\Domain\Media\Models\Media;
use App\Domain\Shared\Http\UserRef;

/**
 * AiGeneration (@storeplix/types, openapi 1.27.0), keys in contract order. Variants are the sanitized, server-built
 * output (P89D-53); a private result photo is presented through a signed link (no srcset) until it is saved to a
 * product. Never usage tokens, request hashes, idempotency keys or provider payloads.
 */
final class AiGenerationPresenter
{
    // Contract key order (jsonb does not keep insertion order on Postgres).
    private const DESCRIPTION_INPUT = ['product_id', 'name', 'category', 'key_points', 'language', 'tone', 'length', 'variants', 'use_product_image'];

    private const PHOTO_INPUT = ['media_id', 'product_id', 'operation', 'background'];

    private const VARIANT = ['description_html', 'paragraphs', 'highlights', 'seo_title', 'meta_description'];

    /** @param array<string, mixed> $data @param list<string> $keys @return array<string, mixed> */
    private static function ordered(array $data, array $keys): array
    {
        $out = [];
        foreach ($keys as $key) {
            if (array_key_exists($key, $data)) {
                $out[$key] = $data[$key];
            }
        }

        return $out;
    }

    /** @return array<string, mixed> */
    public static function present(AiGeneration $g): array
    {
        $product = $g->product_id !== null ? $g->product : null;
        $output = (array) ($g->output ?? []);
        $photo = $g->kind === AiGeneration::PHOTO;

        return [
            'id' => $g->id,
            'kind' => $g->kind,
            'status' => $g->status,
            'product' => $product !== null ? ['id' => $product->id, 'name' => (string) $product->name] : null,
            'credits' => $g->credits,
            'charged_from' => $g->charged_from,
            'refunded' => $g->refunded,
            'input' => (object) self::ordered((array) $g->input, $photo ? self::PHOTO_INPUT : self::DESCRIPTION_INPUT),
            'variants' => ! $photo && $g->status !== AiGeneration::FAILED && isset($output['variants'])
                ? array_values(array_map(fn ($v) => self::ordered((array) $v, self::VARIANT), (array) $output['variants'])) : null,
            'source_image' => $photo ? self::image($g->source_media_id) : null,
            'result_image' => $photo ? self::image($g->result_media_id) : null,
            'check_edges' => (bool) (((array) $g->flags)['check_edges'] ?? false),
            'error_code' => $g->error_code,
            'requested_by' => UserRef::of($g->requester),
            'created_at' => UserRef::iso($g->created_at),
            'finished_at' => UserRef::iso($g->finished_at),
            'applied_at' => UserRef::iso($g->applied_at),
            'undone_at' => UserRef::iso($g->undone_at),
            'original_kept_until' => UserRef::iso($g->original_kept_until),
        ];
    }

    /** @return array<string, mixed>|null StorefrontMedia */
    private static function image(?string $mediaId): ?array
    {
        $media = $mediaId !== null ? Media::query()->find($mediaId) : null;
        if ($media === null || $media->status === Media::FAILED) {
            return null;
        }
        if ($media->purpose === MediaPurpose::AiPhoto->value) {
            return ['id' => $media->id, 'url' => AiPhotoLibrary::link($media), 'width' => $media->width, 'height' => $media->height, 'alt' => null, 'srcset' => []];
        }

        return MediaMaps::storefrontMedia($media);
    }
}
