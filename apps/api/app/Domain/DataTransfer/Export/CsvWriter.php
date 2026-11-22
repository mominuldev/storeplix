<?php

namespace App\Domain\DataTransfer\Export;

use App\Domain\DataTransfer\Csv\CsvCell;
use League\Csv\Writer;

/** RFC 4180 writer for every CSV we hand out: UTF-8 BOM, CRLF, every field quoted, every cell formula-safe. */
final class CsvWriter
{
    public static function toPath(string $path): Writer
    {
        // The output BOM only applies to toString()/download(); a file gets it written up front.
        file_put_contents($path, Writer::BOM_UTF8);
        $writer = Writer::createFromPath($path, 'a');
        self::configure($writer);
        $writer->setOutputBOM('');

        return $writer;
    }

    public static function toString(): Writer
    {
        $writer = Writer::fromString();
        self::configure($writer);

        return $writer;
    }

    private static function configure(Writer $writer): void
    {
        $writer->setOutputBOM(Writer::BOM_UTF8);
        $writer->setEndOfLine("\r\n");
        $writer->forceEnclosure();
        $writer->addFormatter(fn (array $row) => array_map(fn ($cell) => CsvCell::safe((string) $cell), $row));
    }
}
