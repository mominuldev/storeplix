<?php

declare(strict_types=1);

namespace App\Domain\Sms\Templates;

use App\Domain\Identity\Models\User;
use App\Domain\Orders\Notifications\SmsTemplates;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Sms\Models\SmsTemplate;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Support\AuditLogger;
use Illuminate\Database\UniqueConstraintViolationException;
use Illuminate\Support\Facades\DB;

/**
 * PHASE-8-9A §7.2: save / reset a store's custom SMS body. Only custom bodies are stored: saving the default text deletes
 * the row. A stale `revision` → 409 `revision_conflict`. Audits carry lengths only, never the texts (§11.1).
 */
final class SmsTemplateService
{
    public function __construct(private readonly AuditLogger $audit) {}

    public function update(Store $store, string $key, string $language, string $body, ?int $revision, User $user): ?SmsTemplate
    {
        $checked = SmsTemplateCatalog::validate($store, $key, $language, $body);
        $body = $checked['body'];
        $default = SmsTemplates::defaultBody($key, $language);

        try {
            return DB::transaction(function () use ($store, $key, $language, $body, $revision, $user, $default) {
                $row = SmsTemplate::query()->where('store_id', $store->id)->where('key', $key)->where('language', $language)->lockForUpdate()->first();
                if ($revision !== null && $revision !== ($row?->revision ?? 0)) {
                    throw self::conflict();
                }
                $oldLength = mb_strlen($row?->body ?? $default);
                if ($body === trim($default)) {
                    if ($row !== null) {
                        $row->delete();
                        $this->audit->log('sms_template.updated', $row, ['key' => $key, 'language' => $language, 'old_length' => $oldLength,
                            'new_length' => mb_strlen($body), 'is_custom' => false], $user);
                    }

                    return null;
                }
                if ($row !== null && $row->body === $body) {
                    return $row;
                }
                $row ??= new SmsTemplate;
                $isNew = ! $row->exists;
                $row->forceFill([
                    'store_id' => $store->id,
                    'key' => $key,
                    'language' => $language,
                    'body' => $body,
                    'revision' => $isNew ? 1 : $row->revision + 1,
                    'updated_by' => $user->id,
                ])->save();
                $this->audit->log('sms_template.updated', $row, ['key' => $key, 'language' => $language, 'old_length' => $oldLength,
                    'new_length' => mb_strlen($body), 'is_custom' => true], $user);

                return $row;
            });
        } catch (UniqueConstraintViolationException) {
            throw self::conflict();
        }
    }

    /** Idempotent reset to the default body. */
    public function reset(Store $store, string $key, string $language, User $user): void
    {
        SmsTemplateCatalog::assertEditable($key);
        DB::transaction(function () use ($store, $key, $language, $user) {
            $row = SmsTemplate::query()->where('store_id', $store->id)->where('key', $key)->where('language', $language)->lockForUpdate()->first();
            if ($row === null) {
                return;
            }
            $row->delete();
            $this->audit->log('sms_template.reset', $row, ['key' => $key, 'language' => $language, 'old_length' => mb_strlen($row->body)], $user);
        });
    }

    private static function conflict(): ApiException
    {
        return new ApiException(409, 'revision_conflict', 'Someone else changed this template. Reload it and try again.');
    }
}
