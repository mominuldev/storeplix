<?php

namespace App\Domain\Documents;

use chillerlan\QRCode\QRCode;
use chillerlan\QRCode\QROptions;
use Picqer\Barcode\BarcodeGeneratorSVG;

/**
 * Barcodes and QR codes as SVG data URIs (P5B-54): rendered in PHP, so Chromium needs no network. The data URI goes
 * into an <img src>, so templates keep Blade `{{ }}` escaping (no raw HTML) and the request body carries no URL
 * (the SVG's DOCTYPE / xmlns references sit inside the base64).
 */
final class Codes
{
    /** Code 128 of a consignment id / order number (printable ASCII only; anything else is dropped). */
    public static function code128(string $value, int $height = 60): ?string
    {
        $value = (string) preg_replace('/[^\x20-\x7E]/', '', $value);
        if ($value === '') {
            return null;
        }
        $svg = (new BarcodeGeneratorSVG)->getBarcode($value, BarcodeGeneratorSVG::TYPE_CODE_128, 2, $height);

        return 'data:image/svg+xml;base64,'.base64_encode($svg);
    }

    public static function qr(string $url): string
    {
        $options = new QROptions(['outputType' => 'svg', 'outputBase64' => false, 'addQuietzone' => true, 'svgAddXmlHeader' => false]);

        return 'data:image/svg+xml;base64,'.base64_encode((new QRCode($options))->render($url));
    }
}
