<?php

declare(strict_types=1);

namespace App\Domain\DataTransfer\Import;

use App\Domain\Purchasing\Models\Supplier;
use App\Domain\Purchasing\Models\SupplierPayment;
use App\Domain\Shared\Support\Phone;
use App\Domain\Stores\Models\Store;

/**
 * Dry-run of a suppliers CSV (PHASE-8-8B P88B-15, S177). Match key: normalised phone, else exact name
 * (case-insensitive) among this store's active suppliers (tenant-scoped query). In-file duplicates → error. With
 * update_existing, non-empty cells overwrite and empty cells keep the current value; without it, matches are skipped.
 */
final class SupplierImportValidator
{
    private const FIELDS = ['name', 'contact_name', 'phone', 'city', 'supplies', 'payment_terms_days', 'lead_time_days', 'pays_by_method', 'pays_by_account', 'notes'];

    private const LIMITS = ['contact_name' => 120, 'city' => 80, 'supplies' => 200, 'pays_by_account' => 60];

    /**
     * @param  array<string, string|null>  $columnMap
     * @param  array<string, bool>  $options
     * @param  iterable<int, array<string, string>>  $records
     * @return array{rows: list<array<string, mixed>>, summary: array<string, int>}
     */
    public function validate(Store $store, array $columnMap, array $options, iterable $records): array
    {
        $fieldHeaders = array_flip(array_filter($columnMap));
        $existing = Supplier::query()->where('store_id', $store->id)->whereNull('archived_at')->get();
        $byPhone = $existing->whereNotNull('phone')->keyBy('phone');
        $byName = $existing->keyBy(fn (Supplier $s) => mb_strtolower($s->name));

        $seenPhone = [];
        $seenName = [];
        $summary = ['total' => 0, 'create' => 0, 'update' => 0, 'unchanged' => 0, 'warnings' => 0, 'errors' => 0, 'over_limit' => 0];
        $rows = [];
        foreach ($records as $rowNumber => $cells) {
            $get = fn (string $f) => isset($fieldHeaders[$f]) ? trim((string) ($cells[$fieldHeaders[$f]] ?? '')) : '';
            $row = ['status' => 'ready', 'action' => 'create', 'messages' => []];
            $v = array_fill_keys(self::FIELDS, null);

            $name = ImportValues::text($get('name'));
            if ($name === '') {
                $this->error($row, 'name', 'Enter a supplier name.');
            } else {
                if (mb_strlen($name) > 120) {
                    $this->warn($row, 'name', 'Shortened to 120 characters.');
                }
                $v['name'] = mb_substr($name, 0, 120);
            }
            if (($raw = $get('phone')) !== '') {
                $v['phone'] = Phone::bdMsisdn(ImportValues::digits($raw));
                if ($v['phone'] === null) {
                    $this->error($row, 'phone', 'Enter a Bangladesh mobile number, e.g. 01712345678.');
                }
            }
            foreach (self::LIMITS as $field => $max) {
                $raw = ImportValues::text($get($field));
                if ($raw !== '') {
                    if (mb_strlen($raw) > $max) {
                        $this->warn($row, $field, "Shortened to {$max} characters.");
                    }
                    $v[$field] = mb_substr($raw, 0, $max);
                }
            }
            foreach (['payment_terms_days', 'lead_time_days'] as $field) {
                if (($raw = $get($field)) !== '') {
                    if (preg_match('/^\d{1,3}$/', $raw) === 1 && (int) $raw <= 180) {
                        $v[$field] = (int) $raw;
                    } else {
                        $this->warn($row, $field, 'Use a number of days from 0 to 180 — left empty.');
                    }
                }
            }
            if (($raw = mb_strtolower($get('pays_by_method'))) !== '') {
                if (in_array($raw, SupplierPayment::METHODS, true)) {
                    $v['pays_by_method'] = $raw;
                } else {
                    $this->warn($row, 'pays_by_method', 'Use cash, bkash, nagad, bank, card or other — left empty.');
                }
            }
            if (($raw = ImportValues::text($get('notes'), true)) !== '') {
                if (mb_strlen($raw) > 500) {
                    $this->warn($row, 'notes', 'Shortened to 500 characters.');
                }
                $v['notes'] = mb_substr($raw, 0, 500);
            }

            if ($v['phone'] !== null) {
                if (isset($seenPhone[$v['phone']])) {
                    $this->error($row, 'phone', 'Same phone as row '.$seenPhone[$v['phone']].'.');
                }
                $seenPhone[$v['phone']] ??= $rowNumber;
            }
            $nameKey = $v['name'] !== null ? mb_strtolower($v['name']) : null;
            if ($nameKey !== null) {
                if (isset($seenName[$nameKey])) {
                    $this->error($row, 'name', 'Same name as row '.$seenName[$nameKey].'.');
                }
                $seenName[$nameKey] ??= $rowNumber;
            }

            $match = ($v['phone'] !== null ? $byPhone->get($v['phone']) : null) ?? ($nameKey !== null ? $byName->get($nameKey) : null);
            $target = null;
            if ($row['status'] !== 'error' && $match !== null) {
                $target = $match->id;
                $other = $nameKey !== null ? $byName->get($nameKey) : null;
                if (! $options['update_existing']) {
                    $this->warn($row, 'name', 'A supplier with this phone or name already exists — skipped.');
                    $row['action'] = 'skip';
                } elseif ($other !== null && $other->id !== $match->id) {
                    $this->error($row, 'name', 'Another supplier already has this name.');
                } else {
                    if ($nameKey === mb_strtolower($match->name)) {
                        $v['name'] = null; // matched by the same name: keep the existing spelling
                    }
                    $row['action'] = $this->changed($v, $match) ? 'update' : 'unchanged';
                }
            }

            if ($row['status'] === 'error') {
                $row['action'] = 'skip';
                $summary['errors']++;
            } else {
                $summary['warnings'] += $row['status'] === 'warning' ? 1 : 0;
                if (isset($summary[$row['action']])) {
                    $summary[$row['action']]++;
                }
            }
            $summary['total']++;
            $rows[] = [
                'row_number' => $rowNumber,
                'status' => $row['status'],
                'action' => $row['action'],
                'label' => mb_substr($v['name'] ?? $get('name'), 0, 200),
                'key' => $v['phone'] ?? $nameKey,
                'values' => ['supplier' => $v, 'target_id' => $target],
                'messages' => $row['messages'],
            ];
        }

        return ['rows' => $rows, 'summary' => $summary];
    }

    /** @param array<string, mixed> $v */
    private function changed(array $v, Supplier $current): bool
    {
        foreach (self::FIELDS as $field) {
            if ($v[$field] !== null && $v[$field] !== $current->{$field}) {
                return true;
            }
        }

        return false;
    }

    /** @param array<string, mixed> $row */
    private function warn(array &$row, ?string $field, string $message): void
    {
        $row['messages'][] = ['level' => 'warning', 'field' => $field, 'message' => $message];
        if ($row['status'] === 'ready') {
            $row['status'] = 'warning';
        }
    }

    /** @param array<string, mixed> $row */
    private function error(array &$row, ?string $field, string $message): void
    {
        $row['messages'][] = ['level' => 'error', 'field' => $field, 'message' => $message];
        $row['status'] = 'error';
    }
}
