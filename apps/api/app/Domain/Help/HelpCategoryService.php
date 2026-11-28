<?php

declare(strict_types=1);

namespace App\Domain\Help;

use App\Domain\Help\Models\HelpArticle;
use App\Domain\Help\Models\HelpCategory;
use App\Domain\Identity\Models\User;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Support\Collection;
use Illuminate\Validation\ValidationException;

/**
 * Help categories (PHASE-8-9C §7.2, P89C-7): ≤ 30, unique slug, fixed icon set, manual order; deleted only when empty.
 * Platform connection; audited `help_category.*` (platform actor, tenant_id null).
 */
final class HelpCategoryService
{
    private const FIELDS = ['slug', 'name_en', 'name_bn', 'description_en', 'description_bn', 'icon'];

    public function __construct(private readonly AuditLogger $audit) {}

    /** @return Collection<int, HelpCategory> */
    public function all(): Collection
    {
        return HelpDb::query(HelpCategory::class)->orderBy('position')->orderBy('name_en')->get();
    }

    /** @param array<string, mixed> $input validated */
    public function create(User $staff, array $input): HelpCategory
    {
        $category = HelpDb::transaction(function () use ($staff, $input) {
            $this->lock();
            if (HelpDb::query(HelpCategory::class)->count() >= HelpCategory::MAX) {
                throw new ApiException(422, 'help_category_limit_reached', 'You can have at most '.HelpCategory::MAX.' topics.');
            }
            $this->assertSlugFree((string) $input['slug'], null);
            /** @var HelpCategory $c */
            $c = HelpDb::make(HelpCategory::class);
            $c->forceFill(self::values($input) + [
                'position' => (int) HelpDb::query(HelpCategory::class)->max('position') + 1,
                'created_by' => $staff->id,
                'updated_by' => $staff->id,
                'revision' => 1,
            ])->save();

            return $c;
        });
        $this->audit->log('help_category.created', $category, ['slug' => $category->slug], $staff, tenantId: false, platform: true);

        return $category->refresh();
    }

    /** @param array<string, mixed> $input validated */
    public function update(string $id, User $staff, array $input): HelpCategory
    {
        $changed = [];
        $category = HelpDb::transaction(function () use ($id, $staff, $input, &$changed) {
            $c = $this->find($id, true);
            if ((int) $input['revision'] !== $c->revision) {
                throw new ApiException(409, 'revision_conflict', 'This topic changed meanwhile. Reload and try again.');
            }
            if (array_key_exists('slug', $input) && $input['slug'] !== $c->slug) {
                $this->lock();
                $this->assertSlugFree((string) $input['slug'], $c->id);
            }
            $c->forceFill(self::values($input));
            $changed = array_keys($c->getDirty());
            $c->forceFill(['updated_by' => $staff->id, 'revision' => $c->revision + 1])->save();

            return $c;
        });
        $this->audit->log('help_category.updated', $category, ['slug' => $category->slug, 'changed' => $changed], $staff, tenantId: false, platform: true);

        return $category->refresh();
    }

    public function delete(string $id, User $staff): void
    {
        $category = HelpDb::transaction(function () use ($id) {
            $c = $this->find($id, true);
            if (HelpDb::query(HelpArticle::class)->where('category_id', $c->id)->exists()) {
                throw new ApiException(409, 'help_category_not_empty', 'Move or delete this topic’s guides first.');
            }
            HelpDb::query(HelpCategory::class)->whereKey($c->id)->delete();

            return $c;
        });
        $this->audit->log('help_category.deleted', $category, ['slug' => $category->slug], $staff, tenantId: false, platform: true);
    }

    /**
     * @param  list<string>  $ids  every category id, in the new order
     * @return Collection<int, HelpCategory>
     */
    public function reorder(array $ids, User $staff): Collection
    {
        HelpDb::transaction(function () use ($ids, $staff) {
            $this->lock();
            $ids = array_map('strtolower', $ids);
            $current = HelpDb::query(HelpCategory::class)->pluck('id')->all();
            sort($current);
            $given = $ids;
            sort($given);
            if (count(array_unique($ids)) !== count($ids) || $given !== $current) {
                throw ValidationException::withMessages(['ids' => ['Send every topic id exactly once.']]);
            }
            foreach ($ids as $position => $id) {
                HelpDb::query(HelpCategory::class)->whereKey($id)->where('position', '<>', $position)
                    ->update(['position' => $position, 'updated_by' => $staff->id, 'updated_at' => now()]);
            }
        });

        return $this->all();
    }

    public function find(string $id, bool $lock = false): HelpCategory
    {
        $q = preg_match('/^[0-9A-Za-z]{26}$/', $id) === 1 ? HelpDb::query(HelpCategory::class)->whereKey(strtolower($id)) : null;
        $row = $q === null ? null : ($lock ? $q->lockForUpdate()->first() : $q->first());

        return $row instanceof HelpCategory ? $row : throw new ApiException(404, 'not_found', 'Resource not found.');
    }

    /**
     * @param  array<string, mixed>  $input
     * @return array<string, mixed>
     */
    private static function values(array $input): array
    {
        $out = [];
        foreach (self::FIELDS as $field) {
            if (array_key_exists($field, $input)) {
                $value = is_string($input[$field]) ? trim($input[$field]) : $input[$field];
                $out[$field] = $value === '' && $field !== 'slug' && $field !== 'name_en' && $field !== 'icon' ? null : $value;
            }
        }

        return $out;
    }

    private function assertSlugFree(string $slug, ?string $id): void
    {
        if (HelpDb::query(HelpCategory::class)->where('slug', $slug)->when($id !== null, fn ($q) => $q->whereKeyNot($id))->exists()) {
            throw new ApiException(409, 'help_category_slug_taken', 'Another topic already uses this link.');
        }
    }

    private function lock(): void
    {
        if (HelpDb::pgsql()) {
            HelpDb::connection()->select('SELECT pg_advisory_xact_lock(hashtext(?))', ['help-categories']);
        }
    }
}
