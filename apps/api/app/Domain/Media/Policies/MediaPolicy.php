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

    /** PHASE-8-7 §5.4: never for an `expense_receipt` (opened only through the expenses domain's signed link). */
    public function view(User $user, Media $media): bool
    {
        return ! self::privateDocument($media) && $this->inCurrentTenant($media);
    }

    /** Branding assets (logo/favicon) are store settings (settings.manage); others need products.edit or settings.manage. */
    public function delete(User $user, Media $media): bool
    {
        if (self::privateDocument($media) || ! $this->inCurrentTenant($media)) {
            return false; // receipts / supplier invoices are deleted only by their own domain (§5.4, PHASE-8-8B §3)
        }

        $branding = in_array($media->purpose, [MediaPurpose::Logo->value, MediaPurpose::Favicon->value], true);

        return $branding
            ? $this->can(Permission::SettingsManage)
            : $this->can(Permission::ProductsEdit, Permission::SettingsManage);
    }

    /** `expense_receipt` (8.7) and `purchase_invoice` (8.8b): private documents outside the media library. */
    private static function privateDocument(Media $media): bool
    {
        return MediaPurpose::tryFrom($media->purpose)?->isPrivate() ?? false;
    }
}
