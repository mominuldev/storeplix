<?php

namespace App\Domain\Media;

use App\Domain\Media\Models\Media;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Contracts\Filesystem\Filesystem;
use Illuminate\Support\Facades\Storage;

/**
 * The only place media object paths are built: tenants/{tenant_id}/media/{media_id}/{file}.
 * Paths always come from the current TenantContext, never from user input.
 */
class TenantStorage
{
    public function __construct(private readonly TenantContext $context) {}

    public function diskName(): string
    {
        return (string) config('storeplix.media_disk', 'public');
    }

    public function disk(?string $name = null): Filesystem
    {
        return Storage::disk($name ?? $this->diskName());
    }

    public function directory(string $mediaId): string
    {
        return 'tenants/'.$this->context->requireId().'/media/'.$mediaId;
    }

    public function path(string $mediaId, string $file): string
    {
        return $this->directory($mediaId).'/'.$file;
    }

    /** Absolute public URL for an object path. */
    public function url(string $disk, string $path): string
    {
        $base = config('storeplix.media_url');

        if (is_string($base) && $base !== '') {
            return rtrim($base, '/').'/'.ltrim($path, '/');
        }

        $url = $this->disk($disk)->url($path);

        return str_starts_with($url, 'http') ? $url : rtrim((string) config('app.url'), '/').'/'.ltrim($url, '/');
    }

    // --- Phase 4: private bulk-data files (CSV imports and exports, ADR 0009) ---

    public function privateDiskName(): string
    {
        return (string) config('storeplix.private_disk', 'local');
    }

    public function privateDisk(): Filesystem
    {
        return Storage::disk($this->privateDiskName());
    }

    /** tenants/{tenant}/imports/{ulid}.csv */
    public function importPath(string $id): string
    {
        return 'tenants/'.$this->context->requireId().'/imports/'.$id.'.csv';
    }

    /** tenants/{tenant}/exports/{ulid}.csv */
    public function exportPath(string $id): string
    {
        return 'tenants/'.$this->context->requireId().'/exports/'.$id.'.csv';
    }

    /** True only for a path under the CURRENT tenant's prefix (a stored path of tenant B is never read under A). */
    public function ownsPath(string $path): bool
    {
        return str_starts_with($path, 'tenants/'.$this->context->requireId().'/') && ! str_contains($path, '..');
    }

    public function deleteAll(Media $media): void
    {
        $this->disk($media->disk)->deleteDirectory('tenants/'.$media->tenant_id.'/media/'.$media->id);
    }
}
