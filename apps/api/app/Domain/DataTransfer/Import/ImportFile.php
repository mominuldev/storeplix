<?php

namespace App\Domain\DataTransfer\Import;

use App\Domain\DataTransfer\Csv\CsvCell;
use App\Domain\DataTransfer\Csv\CsvInspector;
use App\Domain\DataTransfer\Models\DataImport;
use App\Domain\Media\TenantStorage;
use RuntimeException;

/** Reads a stored import file (private disk, current tenant's prefix only) as [row_number → header → value]. */
final class ImportFile
{
    /**
     * @template T
     *
     * @param  callable(string): T  $callback  receives a local path
     * @return T
     */
    public static function withLocalPath(DataImport $import, callable $callback): mixed
    {
        $storage = app(TenantStorage::class);
        if (! $storage->ownsPath($import->file_path)) {
            throw new RuntimeException('Import file is outside the current tenant.');
        }
        $disk = $storage->privateDisk();
        $tmp = tempnam(sys_get_temp_dir(), 'imp');
        $out = fopen($tmp, 'wb');
        $in = $disk->readStream($import->file_path);
        if ($in === null || $out === false) {
            throw new RuntimeException('Import file is missing.');
        }
        stream_copy_to_stream($in, $out);
        fclose($out);
        if (is_resource($in)) {
            fclose($in);
        }

        try {
            return $callback($tmp);
        } finally {
            @unlink($tmp);
        }
    }

    /**
     * @return iterable<int, array<string, string>> row_number (header row = 1) → header → unescaped value
     */
    public static function rows(string $path, DataImport $import): iterable
    {
        $headers = null;
        foreach (CsvInspector::records($path, $import->delimiter) as $offset => $record) {
            if ($headers === null) {
                $headers = $import->headers;

                continue;
            }
            $cells = [];
            foreach ($headers as $i => $header) {
                $cells[$header] = CsvCell::unescape((string) ($record[$i] ?? ''));
            }
            yield $offset + 1 => $cells;
        }
    }

    /**
     * Raw records for the error report: row_number → original cells.
     *
     * @return iterable<int, list<string>>
     */
    public static function raw(string $path, DataImport $import): iterable
    {
        $first = true;
        foreach (CsvInspector::records($path, $import->delimiter) as $offset => $record) {
            if ($first) {
                $first = false;

                continue;
            }
            yield $offset + 1 => $record;
        }
    }
}
