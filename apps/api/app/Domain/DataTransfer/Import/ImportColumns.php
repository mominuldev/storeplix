<?php

namespace App\Domain\DataTransfer\Import;

use App\Domain\DataTransfer\Models\DataImport;

/** Column specs of §5.2 / §5.3: fields, header aliases (auto-match, case-insensitive), template rows. */
final class ImportColumns
{
    public const PRODUCT_FIELDS = [
        'handle', 'name', 'description', 'status', 'category', 'tags',
        'option1_name', 'option1_value', 'option2_name', 'option2_value', 'option3_name', 'option3_value',
        'sku', 'barcode', 'price', 'compare_at_price', 'cost_price', 'stock', 'weight_kg',
        'seo_title', 'seo_description', 'image_urls',
    ];

    public const CUSTOMER_FIELDS = ['name', 'phone', 'email', 'district', 'area', 'channel', 'tags', 'accepts_marketing', 'note'];

    /** Customer export = import columns minus `note`. */
    public const CUSTOMER_EXPORT_FIELDS = ['name', 'phone', 'email', 'district', 'area', 'channel', 'tags', 'accepts_marketing'];

    private const PRODUCT_ALIASES = [
        'handle' => ['handle', 'url handle', 'slug'],
        'name' => ['name', 'title', 'product name'],
        'description' => ['description', 'body', 'body (html)'],
        'status' => ['status', 'published'],
        'category' => ['category', 'categories', 'product category'],
        'tags' => ['tags'],
        'option1_name' => ['option1 name', 'option 1 name'],
        'option1_value' => ['option1 value', 'option 1 value'],
        'option2_name' => ['option2 name', 'option 2 name'],
        'option2_value' => ['option2 value', 'option 2 value'],
        'option3_name' => ['option3 name', 'option 3 name'],
        'option3_value' => ['option3 value', 'option 3 value'],
        'sku' => ['sku', 'variant sku'],
        'barcode' => ['barcode', 'variant barcode'],
        'price' => ['price', 'price (bdt)', 'variant price', 'regular price'],
        'compare_at_price' => ['compare at price', 'compare-at price', 'variant compare at price', 'sale price'],
        'cost_price' => ['cost', 'cost price', 'cost per item'],
        'stock' => ['stock', 'qty', 'quantity', 'stock quantity', 'variant inventory qty'],
        'weight_kg' => ['weight', 'weight (kg)', 'variant grams'],
        'seo_title' => ['seo title'],
        'seo_description' => ['seo description'],
        'image_urls' => ['image', 'image url', 'photos', 'image src', 'images'],
    ];

    private const CUSTOMER_ALIASES = [
        'name' => ['name', 'full name', 'customer name'],
        'phone' => ['phone', 'mobile', 'phone number', 'mobile number'],
        'email' => ['email', 'email address', 'e-mail'],
        'district' => ['district', 'city'],
        'area' => ['area', 'thana', 'upazila'],
        'channel' => ['channel', 'source'],
        'tags' => ['tags'],
        'accepts_marketing' => ['accepts marketing', 'accepts_marketing', 'marketing'],
        'note' => ['note', 'notes'],
    ];

    /** @return list<string> */
    public static function fields(string $type): array
    {
        return $type === DataImport::PRODUCTS ? self::PRODUCT_FIELDS : self::CUSTOMER_FIELDS;
    }

    /**
     * header → suggested field (null = unmatched). Each field is suggested at most once.
     *
     * @param  list<string>  $headers
     * @return array<string, string|null>
     */
    public static function suggest(string $type, array $headers): array
    {
        $aliases = $type === DataImport::PRODUCTS ? self::PRODUCT_ALIASES : self::CUSTOMER_ALIASES;
        $lower = array_map(fn ($h) => mb_strtolower(trim($h)), $headers);
        $map = array_fill_keys($headers, null);
        $used = [];

        // WooCommerce: with both Regular and Sale price, sale → price and regular → compare-at.
        $woo = $type === DataImport::PRODUCTS && in_array('regular price', $lower, true) && in_array('sale price', $lower, true);

        foreach ($headers as $i => $header) {
            $h = $lower[$i];
            $field = null;
            if ($woo && $h === 'sale price') {
                $field = 'price';
            } elseif ($woo && $h === 'regular price') {
                $field = 'compare_at_price';
            } else {
                foreach ($aliases as $candidate => $names) {
                    if ($h === $candidate || in_array($h, $names, true)) {
                        $field = $candidate;
                        break;
                    }
                }
            }
            // A single "size" / "colour" column is an option (name = the header, value = the cell).
            if ($field === null && $type === DataImport::PRODUCTS && in_array($h, ['size', 'colour', 'color'], true)) {
                foreach ([1, 2, 3] as $n) {
                    if (! isset($used["option{$n}_value"]) && ! in_array("option{$n} value", $lower, true)) {
                        $field = "option{$n}_value";
                        break;
                    }
                }
            }
            if ($field !== null && ! isset($used[$field])) {
                $map[$header] = $field;
                $used[$field] = true;
            }
        }

        return $map;
    }

    /** @return list<list<string>> header + 2 example rows */
    public static function template(string $type): array
    {
        if ($type === DataImport::PRODUCTS) {
            $header = self::PRODUCT_FIELDS;
            $rows = [
                ['jamdani-three-piece', 'Jamdani Three-Piece', 'Soft handwoven Dhakai jamdani three-piece.', 'active', 'Women > Three-piece', 'jamdani, eid',
                    'Size', 'M', '', '', '', '', 'JT-M', '', '3450', '3950', '2100', '14', '0.6', '', '', ''],
                ['jamdani-three-piece', '', '', '', '', '',
                    'Size', 'L', '', '', '', '', 'JT-L', '', '3450', '3950', '2100', '9', '0.6', '', '', ''],
            ];
        } else {
            $header = self::CUSTOMER_FIELDS;
            $rows = [
                ['Farhana Rahman', '01556120987', 'farhana@example.com', 'Narayanganj', 'Fatullah', 'instagram', 'repeat buyer', 'yes', 'Prefers evening delivery'],
                ['Rakib Hasan', '01712345678', '', 'Dhaka', 'Mirpur', 'facebook', '', 'no', ''],
            ];
        }

        return [$header, ...$rows];
    }
}
