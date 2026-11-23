<?php

namespace App\Domain\Media\Policies;

use App\Domain\Identity\Models\User;
use App\Domain\Media\MediaPurpose;
use App\Domain\Media\Models\Media;
use App\Domain\Tenancy\Authorization\Authorizes;
use App\Domain\Tenancy\Authorization\Permission;

class MediaPolicy
{
    use Authorizes;

    public function view(User $user, Media $media): bool
    {
        return $this->inCurrentTenant($media);
    }

    /** Branding assets (logo/favicon) are store settings (settings.manage); others need products.edit or settings.manage. */
    public function delete(User $user, Media $media): bool
    {
        if (! $this->inCurrentTenant($media)) {
            return false;
        }

        $branding = in_array($media->purpose, [MediaPurpose::Logo->value, MediaPurpose::Favicon->value], true);

        return $branding
            ? $this->can(Permission::SettingsManage)
            : $this->can(Permission::ProductsEdit, Permission::SettingsManage);
    }
}
