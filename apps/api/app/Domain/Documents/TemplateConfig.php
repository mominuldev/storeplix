<?php

namespace App\Domain\Documents;

use App\Domain\Documents\Models\DocumentTemplate;

/** DocumentTemplateConfig (P5B-52): kinds, fixed paper per kind, defaults, validation rules. */
final class TemplateConfig
{
    public const KINDS = ['invoice_a4', 'receipt_80mm', 'invoice_a5_two_up', 'packing_slip', 'label_4x6'];

    /** Invoice-type kinds mark orders.invoice_printed_at; the label marks label_printed_at. */
    public const INVOICE_KINDS = ['invoice_a4', 'receipt_80mm', 'invoice_a5_two_up'];

    /** Paper per kind (Q51); height null = one long page (80 mm roll). */
    public const PAPER = [
        'invoice_a4' => ['width_mm' => 210, 'height_mm' => 297, 'label' => 'A4'],
        'receipt_80mm' => ['width_mm' => 80, 'height_mm' => null, 'label' => '80 mm roll'],
        'invoice_a5_two_up' => ['width_mm' => 210, 'height_mm' => 297, 'label' => 'A4 · two A5'],
        'packing_slip' => ['width_mm' => 210, 'height_mm' => 297, 'label' => 'A4'],
        'label_4x6' => ['width_mm' => 100, 'height_mm' => 150, 'label' => '4 × 6 in'],
    ];

    /** @return array{show_logo: bool, show_bin: bool, show_product_names: bool, show_prices: bool, show_sku: bool, language: string, footer_text: string|null} */
    public static function defaults(string $kind): array
    {
        return [
            'show_logo' => true,
            'show_bin' => false,
            'show_product_names' => true,
            'show_prices' => ! in_array($kind, ['packing_slip', 'label_4x6'], true),
            'show_sku' => false,
            'language' => 'en',
            'footer_text' => null,
        ];
    }

    /** @return array<string, list<mixed>> rules for a `config` object under $prefix */
    public static function rules(string $prefix = 'config', bool $required = true): array
    {
        $req = $required ? 'required' : 'sometimes';

        return [
            $prefix => [$req, 'array:show_logo,show_bin,show_product_names,show_prices,show_sku,language,footer_text'],
            "{$prefix}.show_logo" => [$req, 'boolean:strict'],
            "{$prefix}.show_bin" => [$req, 'boolean:strict'],
            "{$prefix}.show_product_names" => [$req, 'boolean:strict'],
            "{$prefix}.show_prices" => [$req, 'boolean:strict'],
            "{$prefix}.show_sku" => [$req, 'boolean:strict'],
            "{$prefix}.language" => [$req, 'string', 'in:en,bn'],
            "{$prefix}.footer_text" => [$required ? 'present' : 'sometimes', 'nullable', 'string', 'max:300', 'regex:/^[^\x00-\x09\x0B-\x1F\x7F]*$/u'],
        ];
    }

    /**
     * Normalised config: known keys only, defaults for missing ones; labels never print prices (P5B-52).
     *
     * @param  array<string, mixed>|null  $config
     * @return array<string, mixed>
     */
    public static function normalise(string $kind, ?array $config): array
    {
        $out = array_intersect_key(($config ?? []) + self::defaults($kind), self::defaults($kind));
        foreach (['show_logo', 'show_bin', 'show_product_names', 'show_prices', 'show_sku'] as $flag) {
            $out[$flag] = (bool) $out[$flag];
        }
        $out['language'] = $out['language'] === 'bn' ? 'bn' : 'en';
        $footer = is_string($out['footer_text']) ? trim($out['footer_text']) : '';
        $out['footer_text'] = $footer === '' ? null : mb_substr($footer, 0, 300);
        if ($kind === 'label_4x6') {
            $out['show_prices'] = false;
        }

        return $out;
    }

    /** @return array<string, mixed> DocumentTemplate payload */
    public static function present(string $kind, ?DocumentTemplate $row): array
    {
        return [
            'kind' => $kind,
            'config' => self::normalise($kind, $row?->config),
            'paper' => self::PAPER[$kind],
            'is_default' => $row === null,
            'revision' => $row?->revision ?? 0,
            'updated_at' => $row?->updated_at?->copy()->utc()->format('Y-m-d\TH:i:s\Z'),
        ];
    }
}
