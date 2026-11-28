<?php

declare(strict_types=1);

namespace App\Domain\Inbox;

use App\Domain\Inbox\Models\InboxSetting;
use App\Domain\Inbox\Support\InboxText;
use App\Domain\Inbox\Support\InboxVersion;
use App\Domain\Inbox\Support\ReplyAddress;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Revalidation\RevalidateStorefront;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Support\Facades\DB;

/**
 * Channel settings (PHASE-8-8E §4, P88E-20): an absent row = every channel off; the row is created on the first
 * write. First email enable generates the inbound key; rotate replaces it (the old address stops at once). Turning
 * website chat or order messages on/off revalidates the storefront (config carries `inbox`, §9.1). Audited.
 */
final class InboxSettingsService
{
    public function __construct(
        private readonly AuditLogger $audit,
        private readonly TenantContext $context,
        private readonly InboxVersion $version,
    ) {}

    public function find(string $storeId): ?InboxSetting
    {
        return InboxSetting::query()->where('store_id', $storeId)->first();
    }

    /** Q299: the email channel needs a configured inbound driver and mail domain. */
    public static function emailAvailable(): bool
    {
        $driver = (string) config('inbox.inbound_driver', '');
        if ($driver === 'fake' && app()->environment('production')) {
            return false;
        }

        return in_array($driver, ['fake', 'mailgun'], true) && ReplyAddress::domain() !== '';
    }

    /** @param array<string, mixed> $input validated UpdateInboxSettingsInput */
    public function update(Store $store, array $input, string $userId): InboxSetting
    {
        [$settings, $changed, $revalidate] = DB::transaction(function () use ($store, $input, $userId) {
            $settings = InboxSetting::query()->where('store_id', $store->id)->lockForUpdate()->first();
            $current = $settings?->revision ?? 1;
            if ((int) $input['revision'] !== $current) {
                throw new ApiException(409, 'revision_conflict', 'These settings changed meanwhile. Reload and try again.');
            }
            if (($input['email_enabled'] ?? false) === true && ! self::emailAvailable()) {
                throw new ApiException(422, 'inbox_email_unavailable', 'Email replies are not available yet on this platform.');
            }
            $settings ??= $this->newRow($store->id);
            $before = $settings->only(['web_chat_enabled', 'order_messages_enabled', 'email_enabled', 'widget_reply_time', 'widget_hours', 'widget_greeting']);
            foreach (['web_chat_enabled', 'order_messages_enabled', 'email_enabled', 'widget_reply_time'] as $key) {
                if (array_key_exists($key, $input)) {
                    $settings->{$key} = $input[$key];
                }
            }
            foreach (['widget_hours' => 40, 'widget_greeting' => 200] as $key => $max) {
                if (array_key_exists($key, $input)) {
                    $value = $input[$key] === null ? '' : InboxText::line((string) $input[$key], $max);
                    $settings->{$key} = $value === '' ? null : $value;
                }
            }
            if ($settings->email_enabled && $settings->email_key === null) {
                $settings->email_key = self::newKey();
            }
            $changed = array_keys(array_filter($before, fn ($value, $key) => $settings->{$key} !== $value, ARRAY_FILTER_USE_BOTH));
            if ($changed === []) {
                return [$settings, [], false]; // nothing to save (an absent row stays absent)
            }
            $settings->revision = $current + 1;
            $settings->updated_by = $userId;
            $settings->save();
            $this->audit->log('inbox.settings_updated', null, ['changed' => array_values($changed)]);
            $this->version->bump($store->id);

            return [$settings, $changed, array_intersect($changed, ['web_chat_enabled', 'order_messages_enabled', 'widget_reply_time', 'widget_hours', 'widget_greeting']) !== []];
        });
        if ($revalidate) {
            RevalidateStorefront::dispatch($store->id)->forTenant($this->context->requireId())->afterCommit();
        }

        return $settings->exists ? $settings->refresh() : $settings;
    }

    public function rotate(Store $store, string $userId): InboxSetting
    {
        return DB::transaction(function () use ($store, $userId) {
            $settings = InboxSetting::query()->where('store_id', $store->id)->lockForUpdate()->first() ?? $this->newRow($store->id);
            $settings->email_key = self::newKey();
            $settings->email_key_rotated_at = now();
            $settings->revision = $settings->exists ? $settings->revision + 1 : 2;
            $settings->updated_by = $userId;
            $settings->save();
            $this->audit->log('inbox.email_address_rotated', null, []);

            return $settings->refresh();
        });
    }

    private function newRow(string $storeId): InboxSetting
    {
        $settings = new InboxSetting;
        $settings->store_id = $storeId;
        $settings->revision = 1;

        return $settings;
    }

    /** 12 lowercase base32 characters (60 bits), globally unique by index. */
    public static function newKey(): string
    {
        $alphabet = 'abcdefghijklmnopqrstuvwxyz234567';
        $key = '';
        for ($i = 0; $i < 12; $i++) {
            $key .= $alphabet[random_int(0, 31)];
        }

        return $key;
    }
}
