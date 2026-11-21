<?php

namespace App\Domain\Themes\Http\Resources;

use App\Domain\Media\MediaMaps;
use App\Domain\Shared\Http\UserRef;
use App\Domain\Themes\Models\StoreTheme;
use App\Domain\Themes\ThemeConfigValidator;
use App\Domain\Themes\ThemeRegistry;

/** StoreThemeSummary / StoreTheme (@storeplix/types). */
final class StoreThemePresenter
{
    /** @return array<string, mixed> */
    public static function summary(StoreTheme $theme): array
    {
        $theme->loadMissing(['draftUpdatedBy', 'publishedBy']);

        return [
            'id' => $theme->id,
            'code' => $theme->theme_code,
            'name' => app(ThemeRegistry::class)->name($theme->theme_code),
            'version' => $theme->theme_version,
            'is_active' => $theme->is_active,
            'draft_revision' => $theme->draft_revision,
            'published_revision' => $theme->published_revision,
            'has_unpublished_changes' => $theme->hasUnpublishedChanges(),
            'draft_updated_at' => UserRef::iso($theme->draft_updated_at ?? $theme->updated_at),
            'draft_updated_by' => UserRef::of($theme->draftUpdatedBy),
            'published_at' => UserRef::iso($theme->published_at),
            'published_by' => UserRef::of($theme->publishedBy),
            'applied_at' => UserRef::iso($theme->applied_at),
        ];
    }

    /** @return array<string, mixed> */
    public static function full(StoreTheme $theme): array
    {
        $ids = [
            ...ThemeConfigValidator::mediaIds($theme->draft_config),
            ...ThemeConfigValidator::mediaIds($theme->published_config ?? []),
        ];

        return self::summary($theme) + [
            'draft_config' => ThemeConfigPresenter::present($theme->draft_config),
            'published_config' => $theme->published_config === null ? null : ThemeConfigPresenter::present($theme->published_config),
            'media' => MediaMaps::refs($ids),
        ];
    }
}
