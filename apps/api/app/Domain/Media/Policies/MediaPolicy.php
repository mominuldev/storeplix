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
        return $this->inCurrentTenant($media) && $this->can(Permission::Operate);
    }

    /** Branding assets (logo/favicon) are store settings → owner/admin only. */
    public function delete(User $user, Media $media): bool
    {
        if (! $this->inCurrentTenant($media)) {
            return false;
        }

        $branding = in_array($media->purpose, [MediaPurpose::Logo->value, MediaPurpose::Favicon->value], true);

        return $this->can($branding ? Permission::ManageSettings : Permission::Operate);
    }
}
