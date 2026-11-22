<?php

namespace App\Domain\DataTransfer\Http\Resources;

use App\Domain\DataTransfer\Import\ImportColumns;
use App\Domain\DataTransfer\Models\DataExport;
use App\Domain\DataTransfer\Models\DataImport;
use App\Domain\DataTransfer\Models\DataImportRow;
use App\Domain\Media\TenantStorage;
use App\Domain\Shared\Http\UserRef;
use App\Domain\Stores\Models\Store;
use Illuminate\Support\Facades\URL;

/** DataImport / DataImportRow / DataExport payloads. */
final class DataTransferPresenter
{
    public const SUMMARY_KEYS = ['total', 'create', 'update', 'unchanged', 'warnings', 'errors', 'over_limit'];

    /** @return array<string, mixed> */
    public static function import(DataImport $import): array
    {
        // Contract key order on every database (Postgres jsonb reorders keys, sqlite keeps insertion order).
        $summary = $import->summary === null ? null : array_map(
            fn (string $key) => (int) ($import->summary[$key] ?? 0),
            array_combine(self::SUMMARY_KEYS, self::SUMMARY_KEYS),
        );

        return [
            'id' => $import->id,
            'type' => $import->type,
            'status' => $import->status,
            'filename' => $import->filename,
            'size_bytes' => $import->size_bytes,
            'row_count' => $import->row_count,
            'headers' => $import->headers ?? [],
            'samples' => (object) ($import->samples ?? []),
            'suggested_map' => (object) ImportColumns::suggest($import->type, $import->headers ?? []),
            'column_map' => $import->column_map === null ? null : (object) $import->column_map,
            'options' => ($import->options ?? []) + DataImport::DEFAULT_OPTIONS,
            'summary' => $summary,
            'progress' => ['processed' => $import->processed_rows, 'total' => (int) ($import->row_count ?? 0)],
            'failure_reason' => $import->failure_reason,
            'created_by' => UserRef::of($import->createdBy),
            'created_at' => UserRef::iso($import->created_at),
            'validated_at' => UserRef::iso($import->validated_at),
            'completed_at' => UserRef::iso($import->completed_at),
        ];
    }

    /** @return array<string, mixed> */
    public static function row(DataImportRow $row): array
    {
        $values = $row->values ?? [];
        $variant = $values['variant'] ?? null;

        return [
            'row_number' => $row->row_number,
            'status' => $row->status,
            'action' => $row->action,
            'label' => $row->label,
            'key' => $row->key,
            'preview' => [
                'price_amount' => $variant['price_amount'] ?? null,
                'stock' => $variant['stock'] ?? null,
                'variants' => $values['variants_in_group'] ?? null,
            ],
            'messages' => $row->messages ?? [],
            'result_id' => $row->result_id,
        ];
    }

    /** @return array<string, mixed> download_url is a fresh 5-minute signed URL each call. */
    public static function export(DataExport $export, Store $store): array
    {
        $expired = $export->status === DataExport::EXPIRED
            || ($export->status === DataExport::COMPLETED && $export->expires_at !== null && $export->expires_at->isPast());

        return [
            'id' => $export->id,
            'type' => $export->type,
            'status' => $expired ? DataExport::EXPIRED : $export->status,
            'row_count' => $export->row_count,
            'filename' => $export->status === DataExport::COMPLETED ? self::filename($export, $store) : null,
            'download_url' => $export->status === DataExport::COMPLETED && ! $expired ? self::downloadUrl($export, $store) : null,
            'expires_at' => UserRef::iso($export->expires_at),
            'created_by' => UserRef::of($export->createdBy),
            'created_at' => UserRef::iso($export->created_at),
        ];
    }

    public static function filename(DataExport $export, Store $store): string
    {
        $at = $export->created_at->copy()->setTimezone($store->timezone ?: 'Asia/Dhaka');

        return "{$store->slug}-{$export->type}-{$at->format('Ymd-Hi')}.csv";
    }

    private static function downloadUrl(DataExport $export, Store $store): string
    {
        $storage = app(TenantStorage::class);
        $diskName = $storage->privateDiskName();
        if (config("filesystems.disks.{$diskName}.driver") === 's3') {
            return $storage->privateDisk()->temporaryUrl($export->file_path, now()->addMinutes(5), [
                'ResponseContentDisposition' => 'attachment; filename="'.self::filename($export, $store).'"',
                'ResponseContentType' => 'text/csv; charset=utf-8',
            ]);
        }

        return URL::temporarySignedRoute('exports.download', now()->addMinutes(5), ['export' => $export->id, 'tenant' => $export->tenant_id]);
    }
}
