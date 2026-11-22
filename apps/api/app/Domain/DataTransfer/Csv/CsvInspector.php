<?php

namespace App\Domain\DataTransfer\Csv;

use App\Domain\Shared\Http\ApiException;
use League\Csv\Exception as CsvException;
use League\Csv\Reader;

/**
 * Upload checks (§5.1), in order; the first failure throws. Never decompresses anything.
 *
 * 1. size ≤ 10 MB (413) · 2. no archive / binary magic, no NUL in the first 64 KB · 3. valid UTF-8 (BOM stripped)
 * 4. delimiter from the header line · 5. streaming parse: line ≤ 64 KB, cell ≤ 10 000 chars, ≤ 50 columns,
 * ≤ 5 000 data rows (blank rows skipped) · 6. header names trimmed, non-empty, unique (case-insensitive).
 */
final class CsvInspector
{
    public const MAX_BYTES = 10_485_760;

    public const MAX_ROWS = 5000;

    public const MAX_COLUMNS = 50;

    public const MAX_CELL_CHARS = 10_000;

    public const MAX_LINE_BYTES = 65_536;

    public const UNSUPPORTED = 'Save the file as CSV UTF-8 and try again.';

    private const MAGIC = ["PK\x03\x04", "\x1f\x8b", "\xD0\xCF\x11\xE0", '%PDF'];

    /**
     * @return array{delimiter: string, headers: list<string>, samples: array<string, string|null>, row_count: int}
     */
    public static function inspect(string $path, int $size): array
    {
        if ($size > self::MAX_BYTES) {
            throw new ApiException(413, 'payload_too_large', 'The file is larger than 10 MB.');
        }

        $handle = fopen($path, 'rb');
        if ($handle === false) {
            throw new ApiException(422, 'unsupported_file', self::UNSUPPORTED);
        }

        try {
            $head = (string) fread($handle, 65536);
            foreach (self::MAGIC as $magic) {
                if (str_starts_with($head, $magic)) {
                    throw new ApiException(422, 'unsupported_file', self::UNSUPPORTED);
                }
            }
            if (str_contains($head, "\0")) {
                throw new ApiException(422, 'unsupported_file', self::UNSUPPORTED);
            }

            // UTF-8 + physical line length, streamed in chunks (an incomplete trailing sequence carries over).
            rewind($handle);
            $carry = '';
            $line = 0;
            $first = true;
            while (! feof($handle)) {
                $chunk = $carry.(string) fread($handle, 1 << 20);
                if ($first) {
                    $chunk = str_starts_with($chunk, "\xEF\xBB\xBF") ? substr($chunk, 3) : $chunk;
                    $first = false;
                }
                $cut = self::completeUtf8Length($chunk, feof($handle));
                $carry = substr($chunk, $cut);
                $chunk = substr($chunk, 0, $cut);
                if (! mb_check_encoding($chunk, 'UTF-8')) {
                    throw new ApiException(422, 'unsupported_file', self::UNSUPPORTED);
                }
                foreach (explode("\n", $chunk) as $k => $segment) {
                    $line = $k === 0 ? $line + strlen($segment) : strlen($segment);
                    if ($line > self::MAX_LINE_BYTES) {
                        throw new ApiException(422, 'line_too_long', 'A line in the file is longer than 64 KB.');
                    }
                }
            }
            if ($carry !== '') {
                throw new ApiException(422, 'unsupported_file', self::UNSUPPORTED);
            }
        } finally {
            fclose($handle);
        }

        $headerLine = self::firstLine($path);
        $delimiter = self::delimiter($headerLine);

        $headers = null;
        $samples = [];
        $rows = 0;
        try {
            foreach (self::records($path, $delimiter) as $record) {
                if (count($record) > self::MAX_COLUMNS) {
                    throw new ApiException(422, 'too_many_columns', 'The file has more than '.self::MAX_COLUMNS.' columns.');
                }
                foreach ($record as $cell) {
                    if (mb_strlen((string) $cell) > self::MAX_CELL_CHARS) {
                        throw new ApiException(422, 'cell_too_long', 'A cell is longer than 10 000 characters.');
                    }
                }
                if ($headers === null) {
                    $headers = self::headers($record);
                    $samples = array_fill_keys($headers, null);

                    continue;
                }
                if (++$rows > self::MAX_ROWS) {
                    throw new ApiException(422, 'too_many_rows', 'The file has more than '.self::MAX_ROWS.' rows. Split it and import each part.');
                }
                foreach ($headers as $i => $header) {
                    $value = trim(CsvCell::unescape((string) ($record[$i] ?? '')));
                    if ($samples[$header] === null && $value !== '') {
                        $samples[$header] = mb_substr($value, 0, 60);
                    }
                }
            }
        } catch (CsvException) {
            throw new ApiException(422, 'unsupported_file', self::UNSUPPORTED);
        }

        if ($headers === null || $rows === 0) {
            throw new ApiException(422, 'empty_file', 'The file has no rows to import.');
        }

        return ['delimiter' => $delimiter, 'headers' => $headers, 'samples' => $samples, 'row_count' => $rows];
    }

    /**
     * Non-blank records keyed by their 0-based record offset (the header is the first one).
     *
     * @return iterable<int, list<string>>
     */
    public static function records(string $path, string $delimiter): iterable
    {
        $reader = Reader::createFromPath($path, 'r');
        $reader->setDelimiter($delimiter);
        $reader->skipInputBOM();
        $reader->skipEmptyRecords();

        foreach ($reader->getRecords() as $offset => $record) {
            $values = array_map(fn ($v) => (string) $v, array_values($record));
            if (implode('', array_map('trim', $values)) === '') {
                continue;
            }
            yield (int) $offset => $values;
        }
    }

    /**
     * @param  list<string>  $record
     * @return list<string>
     */
    private static function headers(array $record): array
    {
        $headers = array_map(fn ($h) => trim(CsvCell::unescape((string) $h)), $record);
        $seen = [];
        $errors = [];
        foreach ($headers as $i => $header) {
            if ($header === '') {
                $errors['headers.'.$i] = ['Column '.($i + 1).' has no name.'];
            } elseif (isset($seen[mb_strtolower($header)])) {
                $errors['headers.'.$i] = ['The column "'.mb_substr($header, 0, 60).'" appears twice.'];
            }
            $seen[mb_strtolower($header)] = true;
        }
        if ($errors !== []) {
            throw new ApiException(422, 'validation_failed', 'Fix the column names and upload again.', $errors);
        }

        return $headers;
    }

    private static function firstLine(string $path): string
    {
        $handle = fopen($path, 'rb');
        $line = '';
        while ($handle !== false && ! feof($handle)) {
            $line = (string) fgets($handle, self::MAX_LINE_BYTES + 2);
            $line = str_starts_with($line, "\xEF\xBB\xBF") ? substr($line, 3) : $line;
            if (trim($line) !== '') {
                break;
            }
        }
        if ($handle !== false) {
            fclose($handle);
        }

        return $line;
    }

    /** Most common of , ; TAB outside quotes in the header line (ties → comma). */
    public static function delimiter(string $line): string
    {
        $counts = [',' => 0, ';' => 0, "\t" => 0];
        $quoted = false;
        $length = strlen($line);
        for ($i = 0; $i < $length; $i++) {
            $char = $line[$i];
            if ($char === '"') {
                $quoted = ! $quoted;
            } elseif (! $quoted && isset($counts[$char])) {
                $counts[$char]++;
            }
        }
        arsort($counts);
        $best = array_key_first($counts);

        return $counts[$best] > 0 ? (string) $best : ',';
    }

    /** Length of the prefix of $bytes that ends on a UTF-8 character boundary. */
    private static function completeUtf8Length(string $bytes, bool $final): int
    {
        $length = strlen($bytes);
        if ($final || $length === 0) {
            return $length;
        }
        for ($back = 1; $back <= 3 && $back <= $length; $back++) {
            $byte = ord($bytes[$length - $back]);
            if (($byte & 0xC0) === 0xC0) { // lead byte of a multi-byte sequence
                $need = $byte >= 0xF0 ? 4 : ($byte >= 0xE0 ? 3 : 2);

                return $need > $back ? $length - $back : $length;
            }
            if (($byte & 0x80) === 0) {
                return $length;
            }
        }

        return $length;
    }
}
