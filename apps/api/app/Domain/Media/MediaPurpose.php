<?php

namespace App\Domain\Media;

/**
 * Upload rules per purpose (Phase 2 contract §1.5). MIME is always sniffed from bytes.
 *
 * PHASE-8-7 §5.4: `ExpenseReceipt` is NOT a library purpose. It lives on the private disk and only the expenses domain
 * uploads, attaches and deletes it; the generic `/media` routes use libraryCases() and never accept, list, show, delete
 * or present one. Every match below has an explicit `ExpenseReceipt` arm (no reliance on `default`).
 *
 * PHASE-8-8B §3 (S176): `PurchaseInvoice` (a supplier invoice photo/PDF attached to a purchase receipt) follows exactly
 * the `ExpenseReceipt` rules: private disk, same MIME/size/side limits, no variants, never a library purpose, uploaded,
 * attached and deleted only by the purchasing domain.
 *
 * PHASE-8-9A P89A-16 (S216): `SenderIdDocument` (a trade licence for a masked sender ID request) follows the same rules:
 * private disk, JPG/PNG/WebP/PDF ≤ 5 MB, sniffed, images re-encoded, no variants, never a library purpose. Uploaded only
 * by the SMS sender-ID domain; merchants never download it back, staff stream it from /admin/sender-ids/{id}/document.
 *
 * PHASE-8-8E P88E-7 (S241): `InboxAttachment` (a photo or PDF on an Inbox message or saved reply): private disk, JPG/PNG/PDF
 * only (no WebP), ≤ 5 MB, sniffed, sides 32–10000 px, images re-encoded, no variants, never a library purpose. Uploaded,
 * attached, streamed and deleted only by the Inbox domain.
 *
 * PHASE-8-9C P89C-15 (S255): `SupportAttachment` (a photo or PDF on a support ticket message): private disk, JPG/PNG/PDF
 * only, ≤ 10 MB, sniffed, sides 32–10000 px, images re-encoded, no variants, never a library purpose. Uploaded,
 * attached, streamed and deleted only by the Support domain. `media.purpose` has no CHECK, so no migration is needed.
 *
 * PHASE-8-9D P89D-58 (S346): `AiPhoto` (an AI photo edit result): private disk, written only by the AI domain (already
 * re-encoded, EXIF stripped), no variants, never a library purpose, opened through a signed link until "Save to
 * product" turns it into a normal `product_image` (moved to the media disk, variants rendered).
 */
enum MediaPurpose: string
{
    case Logo = 'logo';
    case Favicon = 'favicon';
    case ProductImage = 'product_image';
    case PageImage = 'page_image';
    case ExpenseReceipt = 'expense_receipt'; // PHASE-8-7 P87-7
    case PurchaseInvoice = 'purchase_invoice'; // PHASE-8-8B §3
    case SenderIdDocument = 'sender_id_document'; // PHASE-8-9A P89A-16
    case InboxAttachment = 'inbox_attachment'; // PHASE-8-8E P88E-7
    case SupportAttachment = 'support_attachment'; // PHASE-8-9C P89C-15
    case AiPhoto = 'ai_photo'; // PHASE-8-9D P89D-58

    public const MAX_PIXELS = 40_000_000;

    /** @return list<string> */
    public function mimes(): array
    {
        return match ($this) {
            self::Favicon => ['image/png'],
            self::ExpenseReceipt, self::PurchaseInvoice, self::SenderIdDocument => ['image/png', 'image/jpeg', 'image/webp', 'application/pdf'],
            self::InboxAttachment, self::SupportAttachment => ['image/jpeg', 'image/png', 'application/pdf'],
            default => ['image/png', 'image/jpeg', 'image/webp'],
        };
    }

    public function maxBytes(): int
    {
        return match ($this) {
            self::Logo => 2 * 1024 * 1024,
            self::Favicon => 1024 * 1024,
            self::ExpenseReceipt, self::PurchaseInvoice, self::SenderIdDocument, self::InboxAttachment => 5 * 1024 * 1024,
            self::SupportAttachment, self::AiPhoto => 10 * 1024 * 1024,
            default => 5 * 1024 * 1024,
        };
    }

    /** @return array{0: int, 1: int} min/max px per side */
    public function sideBounds(): array
    {
        return match ($this) {
            self::Logo => [64, 4096],
            self::Favicon => [64, 1024],
            self::ExpenseReceipt, self::PurchaseInvoice, self::SenderIdDocument => [100, 10000],
            self::InboxAttachment, self::SupportAttachment => [32, 10000],
            self::AiPhoto => [1, 10000],
            default => [200, 6000],
        };
    }

    /** PHASE-8-8B: private documents (receipts, supplier invoices) that never get a public URL. */
    public function isPrivate(): bool
    {
        return ! $this->isLibrary();
    }

    public function mustBeSquare(): bool
    {
        return $this === self::Favicon;
    }

    /**
     * Variant specs: [key, max side px, format]. Never upscaled: a variant larger than the source is skipped.
     *
     * @return list<array{0: string, 1: int, 2: string}>
     */
    public function variants(): array
    {
        return match ($this) {
            self::Logo => [['w160', 160, 'webp'], ['w320', 320, 'webp'], ['w640', 640, 'webp']],
            self::Favicon => [['favicon_32', 32, 'png'], ['apple_180', 180, 'png'], ['icon_192', 192, 'png'], ['icon_512', 512, 'png']],
            self::ExpenseReceipt, self::PurchaseInvoice, self::SenderIdDocument, self::InboxAttachment, self::SupportAttachment, self::AiPhoto => [], // the original is re-encoded (EXIF/GPS stripped); no variants
            default => [['w320', 320, 'webp'], ['w640', 640, 'webp'], ['w1024', 1024, 'webp'], ['w1600', 1600, 'webp']],
        };
    }

    /** Variant used for compact MediaRef / display. A receipt is never presented (no variant, no URL). */
    public function displayVariant(): ?string
    {
        return match ($this) {
            self::Logo => 'w320',
            self::Favicon => 'icon_192',
            self::ExpenseReceipt, self::PurchaseInvoice, self::SenderIdDocument, self::InboxAttachment, self::SupportAttachment, self::AiPhoto => null,
            default => 'w640',
        };
    }

    /** True for the purposes of the generic media library (`/media`). */
    public function isLibrary(): bool
    {
        return $this !== self::ExpenseReceipt && $this !== self::PurchaseInvoice && $this !== self::SenderIdDocument
            && $this !== self::InboxAttachment && $this !== self::SupportAttachment && $this !== self::AiPhoto;
    }

    /** @return list<self> every purpose the generic `/media` routes accept, list and show (all but ExpenseReceipt, PurchaseInvoice, SenderIdDocument, InboxAttachment and SupportAttachment) */
    public static function libraryCases(): array
    {
        return array_values(array_filter(self::cases(), fn (self $p) => $p->isLibrary()));
    }

    /** @return list<string> */
    public static function libraryValues(): array
    {
        return array_map(fn (self $p) => $p->value, self::libraryCases());
    }

    public static function extensionFor(string $mime): string
    {
        return match ($mime) {
            'image/png' => 'png',
            'image/jpeg' => 'jpg',
            'image/webp' => 'webp',
            'application/pdf' => 'pdf',
            default => 'bin',
        };
    }
}
