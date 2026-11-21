<?php

namespace App\Domain\Pages;

use App\Domain\Identity\Models\User;
use App\Domain\Navigation\NavigationService;
use App\Domain\Pages\Models\StorePage;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Models\StoreSetting;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Themes\StoreThemeService;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

/** Pages CRUD rules (PHASE-3-CONTRACT §3.2). Revalidation: StorefrontRevalidationObserver. */
class PageService
{
    public function __construct(
        private readonly PageTemplates $templates,
        private readonly NavigationService $navigation,
        private readonly AuditLogger $audit,
    ) {}

    /**
     * @param  array<string, mixed>  $input  validated CreatePageInput
     */
    public function create(Store $store, array $input, ?User $user, bool $audit = true): StorePage
    {
        if (StorePage::query()->where('store_id', $store->id)->count() >= StorePage::MAX_PER_STORE) {
            throw new ApiException(409, 'page_limit_reached', 'A shop can have at most '.StorePage::MAX_PER_STORE.' pages.');
        }

        $template = $input['template'] ?? 'blank';
        $title = $input['title'] ?? null;
        $slug = $input['slug'] ?? null;
        $explicitSlug = $slug !== null;
        $body = $input['body'] ?? null;

        if ($template !== 'blank' || $body === null) {
            $built = $this->templates->build($template, $store, StoreSetting::query()->where('store_id', $store->id)->first());
            $title ??= $built['title'];
            $slug ??= $built['slug'];
            $body ??= $built['body'];
        }

        $body = $this->body($body);
        $slug = $explicitSlug ? $slug : $this->uniqueSlug($store, $slug ?? self::slugify((string) $title));
        $this->assertSlugFree($store, $slug);
        $status = $input['status'] ?? StorePage::DRAFT;

        return DB::transaction(function () use ($store, $input, $user, $audit, $template, $title, $slug, $body, $status) {
            $page = StorePage::query()->create([
                'store_id' => $store->id,
                'title' => $title,
                'slug' => $slug,
                'status' => $status,
                'template' => $template,
                'body' => $body,
                'seo_title' => $input['seo']['title'] ?? null,
                'seo_description' => $input['seo']['description'] ?? null,
                'og_image_media_id' => $input['seo']['share_image_media_id'] ?? null,
                'published_at' => $status === StorePage::PUBLISHED ? now() : null,
                'created_by' => $user?->getKey(),
                'updated_by' => $user?->getKey(),
            ]);

            if (! empty($input['add_to_menu'])) {
                $this->navigation->appendPage($store, $input['add_to_menu'], $page, $user?->getKey());
            }

            if ($audit) {
                $this->audit->log('page.created', $page, ['template' => $template, 'status' => $status]);
                if ($status === StorePage::PUBLISHED) {
                    $this->audit->log('page.published', $page);
                }
            }

            return $page;
        });
    }

    /**
     * @param  array<string, mixed>  $input  validated UpdatePageInput
     */
    public function update(Store $store, StorePage $page, array $input, ?User $user): StorePage
    {
        $values = [];
        foreach (['title', 'status'] as $key) {
            if (array_key_exists($key, $input)) {
                $values[$key] = $input[$key];
            }
        }
        if (array_key_exists('slug', $input)) {
            if ($input['slug'] !== $page->slug) {
                $this->assertSlugFree($store, $input['slug'], $page->id);
            }
            $values['slug'] = $input['slug'];
        }
        if (array_key_exists('body', $input)) {
            $values['body'] = $this->body($input['body']);
        }
        foreach (['title' => 'seo_title', 'description' => 'seo_description', 'share_image_media_id' => 'og_image_media_id'] as $key => $column) {
            if (isset($input['seo']) && array_key_exists($key, $input['seo'])) {
                $values[$column] = $input['seo'][$key];
            }
        }

        return DB::transaction(function () use ($page, $values, $input, $user) {
            $locked = StorePage::query()->whereKey($page->id)->lockForUpdate()->firstOrFail();
            if ($locked->revision !== (int) $input['revision']) {
                throw StoreThemeService::conflict();
            }

            $wasPublished = $locked->isPublished();
            $locked->fill($values);
            $changes = array_keys($locked->getDirty());
            if (($values['status'] ?? null) === StorePage::PUBLISHED && $locked->published_at === null) {
                $locked->published_at = now();
            }
            $locked->revision++;
            $locked->updated_by = $user?->getKey();
            $locked->save();

            $this->audit->log('page.updated', $locked, ['changes' => array_values(array_map(
                fn ($c) => match ($c) {
                    'seo_title' => 'seo.title', 'seo_description' => 'seo.description', 'og_image_media_id' => 'seo.share_image_media_id', default => $c
                },
                $changes,
            ))]);
            if (! $wasPublished && $locked->isPublished()) {
                $this->audit->log('page.published', $locked);
            }

            return $locked;
        });
    }

    public function delete(StorePage $page): void
    {
        DB::transaction(function () use ($page) {
            $page->delete();
            $this->audit->log('page.deleted', $page, ['slug' => $page->slug]);
        });
    }

    /** @return list<array<string, mixed>> */
    private function body(mixed $body): array
    {
        [$normalised, $errors] = PageBodyValidator::validate($body, 'body');
        if ($errors !== []) {
            throw ValidationException::withMessages($errors);
        }

        return $normalised;
    }

    private function assertSlugFree(Store $store, string $slug, ?string $exceptId = null): void
    {
        if (in_array($slug, StorePage::RESERVED_SLUGS, true)) {
            throw ValidationException::withMessages(['slug' => ['This link is reserved. Choose another one.']]);
        }
        $taken = StorePage::query()->where('store_id', $store->id)->where('slug', $slug)
            ->when($exceptId, fn ($q) => $q->whereKeyNot($exceptId))->exists();
        if ($taken) {
            throw ValidationException::withMessages(['slug' => ['This link is already used by another page.']]);
        }
    }

    /** A default (not user-chosen) slug never collides: "-2", "-3"… are appended. */
    private function uniqueSlug(Store $store, string $base): string
    {
        $base = rtrim(substr($base, 0, 72), '-');
        $base = in_array($base, StorePage::RESERVED_SLUGS, true) ? "{$base}-page" : $base;
        $slug = $base;
        for ($i = 2; StorePage::query()->where('store_id', $store->id)->where('slug', $slug)->exists(); $i++) {
            $slug = "{$base}-{$i}";
        }

        return $slug;
    }

    /** ASCII slug of the title; Bangla-only (non-ASCII) titles fall back to "page-xxxxxx". */
    public static function slugify(string $title): string
    {
        $ascii = (string) preg_replace('/[^\x20-\x7E]+/', ' ', $title);
        $slug = trim((string) preg_replace('/[^a-z0-9]+/', '-', strtolower($ascii)), '-');

        return $slug !== '' ? rtrim(substr($slug, 0, 72), '-') : 'page-'.Str::lower(Str::random(6));
    }
}
