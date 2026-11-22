<?php

namespace App\Domain\DataTransfer\Import;

use App\Domain\Customers\Http\Requests\CustomerRequest;
use App\Domain\Customers\Models\Customer;
use App\Domain\Shared\Support\Phone;
use App\Domain\Stores\Models\Store;

/**
 * Dry-run of a customers CSV (§5.3). Upsert key: normalised phone, else email. In-file duplicates → error.
 * With update_existing, non-empty cells overwrite; empty cells keep the current value. Without it, matches are skipped.
 */
final class CustomerImportValidator
{
    private const FIELDS = ['name', 'phone', 'email', 'district', 'area', 'channel', 'tags', 'accepts_marketing'];

    /**
     * @param  array<string, string|null>  $columnMap
     * @param  array<string, bool>  $options
     * @param  iterable<int, array<string, string>>  $records
     * @return array{rows: list<array<string, mixed>>, summary: array<string, int>}
     */
    public function validate(Store $store, array $columnMap, array $options, iterable $records): array
    {
        $fieldHeaders = array_flip(array_filter($columnMap));
        $existing = Customer::query()->where('store_id', $store->id)->get();
        $byPhone = $existing->whereNotNull('phone')->keyBy('phone');
        $byEmail = $existing->whereNotNull('email')->keyBy('email');

        $seenPhone = [];
        $seenEmail = [];
        $summary = ['total' => 0, 'create' => 0, 'update' => 0, 'unchanged' => 0, 'warnings' => 0, 'errors' => 0, 'over_limit' => 0];
        $rows = [];
        foreach ($records as $rowNumber => $cells) {
            $get = fn (string $f) => isset($fieldHeaders[$f]) ? trim((string) ($cells[$fieldHeaders[$f]] ?? '')) : '';
            $row = ['status' => 'ready', 'action' => 'create', 'messages' => []];
            $v = array_fill_keys([...self::FIELDS, 'note'], null);

            $name = ImportValues::text($get('name'));
            if ($name === '') {
                $this->error($row, 'name', 'Enter a name.');
            } else {
                $v['name'] = mb_substr($name, 0, 120);
            }
            if (($raw = $get('phone')) !== '') {
                $v['phone'] = Phone::bdMsisdn(ImportValues::digits($raw));
                if ($v['phone'] === null) {
                    $this->error($row, 'phone', CustomerRequest::PHONE_MESSAGE);
                }
            }
            if (($raw = mb_strtolower($get('email'))) !== '') {
                if (mb_strlen($raw) <= 254 && filter_var($raw, FILTER_VALIDATE_EMAIL) !== false) {
                    $v['email'] = $raw;
                } else {
                    $this->error($row, 'email', "\"{$raw}\" isn't an email address.");
                }
            }
            if ($get('phone') === '' && $get('email') === '') {
                $this->error($row, 'phone', 'Enter a phone number or an email.');
            }
            foreach (['district' => 80, 'area' => 120] as $field => $max) {
                $raw = ImportValues::text($get($field));
                if ($raw !== '') {
                    if (mb_strlen($raw) > $max) {
                        $this->warn($row, $field, "Shortened to {$max} characters.");
                    }
                    $v[$field] = mb_substr($raw, 0, $max);
                }
            }
            if (($raw = mb_strtolower(str_replace([' ', '-'], '_', $get('channel')))) !== '') {
                if (in_array($raw, Customer::CHANNELS, true)) {
                    $v['channel'] = $raw;
                } else {
                    $this->warn($row, 'channel', "Channel \"{$get('channel')}\" isn't known — left empty.");
                }
            }
            if (($raw = $get('tags')) !== '') {
                $v['tags'] = array_slice(array_map(fn ($t) => mb_substr($t, 0, 40), ImportValues::tags($raw)), 0, 20);
            }
            if (($raw = $get('accepts_marketing')) !== '') {
                $v['accepts_marketing'] = ImportValues::bool($raw);
                if ($v['accepts_marketing'] === null) {
                    $this->warn($row, 'accepts_marketing', 'Use yes or no — left as no.');
                }
            }
            if (($raw = ImportValues::text($get('note'), true)) !== '') {
                $v['note'] = mb_substr($raw, 0, 1000);
            }

            if ($v['phone'] !== null) {
                if (isset($seenPhone[$v['phone']])) {
                    $this->error($row, 'phone', 'Same phone as row '.$seenPhone[$v['phone']].'.');
                }
                $seenPhone[$v['phone']] ??= $rowNumber;
            }
            if ($v['email'] !== null) {
                if (isset($seenEmail[$v['email']])) {
                    $this->error($row, 'email', 'Same email as row '.$seenEmail[$v['email']].'.');
                }
                $seenEmail[$v['email']] ??= $rowNumber;
            }

            $match = ($v['phone'] !== null ? $byPhone->get($v['phone']) : null) ?? ($v['email'] !== null ? $byEmail->get($v['email']) : null);
            $target = null;
            if ($row['status'] !== 'error' && $match !== null) {
                $target = $match->id;
                if (! $options['update_existing']) {
                    $this->warn($row, 'phone', 'A customer with this phone or email already exists — skipped.');
                    $row['action'] = 'skip';
                } else {
                    // The other key must not belong to a different customer.
                    $other = $v['email'] !== null ? $byEmail->get($v['email']) : null;
                    if ($other !== null && $other->id !== $match->id) {
                        $this->error($row, 'email', 'This email belongs to another customer.');
                    } else {
                        $row['action'] = $this->changed($v, $match) ? 'update' : 'unchanged';
                    }
                }
            } elseif ($row['status'] !== 'error') {
                $row['action'] = 'create';
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
                'key' => $v['phone'] ?? $v['email'],
                'values' => ['customer' => $v, 'target_id' => $target],
                'messages' => $row['messages'],
            ];
        }

        return ['rows' => $rows, 'summary' => $summary];
    }

    /** @param array<string, mixed> $v */
    private function changed(array $v, Customer $current): bool
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
