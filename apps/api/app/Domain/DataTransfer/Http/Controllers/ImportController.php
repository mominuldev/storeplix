<?php

namespace App\Domain\DataTransfer\Http\Controllers;

use App\Domain\Billing\Feature;
use App\Domain\Billing\FeatureGate;
use App\Domain\Billing\Limit;
use App\Domain\DataTransfer\Csv\CsvCell;
use App\Domain\DataTransfer\Csv\CsvInspector;
use App\Domain\DataTransfer\Export\CsvWriter;
use App\Domain\DataTransfer\Http\Resources\DataTransferPresenter;
use App\Domain\DataTransfer\Import\ImportColumns;
use App\Domain\DataTransfer\Import\ImportFile;
use App\Domain\DataTransfer\Jobs\RunImport;
use App\Domain\DataTransfer\Jobs\ValidateImport;
use App\Domain\DataTransfer\Models\DataImport;
use App\Domain\DataTransfer\Models\DataImportRow;
use App\Domain\Media\TenantStorage;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Authorization\Permission;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Database\QueryException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Str;
use Illuminate\Validation\ValidationException;

/** §3.4 imports (Permission::DataImport). */
class ImportController
{
    public function __construct(
        private readonly TenantStorage $storage,
        private readonly TenantContext $context,
    ) {}

    /** GET /stores/{store}/imports/template?type= */
    public function template(Request $request, Store $store): Response
    {
        $this->authorize($store);
        $type = $request->validate(['type' => ['required', 'in:products,customers,suppliers']])['type'];
        $writer = CsvWriter::toString();
        $writer->insertAll(ImportColumns::template($type));

        return new Response($writer->toString(), 200, [
            'Content-Type' => 'text/csv; charset=utf-8',
            'Content-Disposition' => "attachment; filename=\"storeplix-{$type}-template.csv\"",
            'Cache-Control' => 'no-store',
        ]);
    }

    /** POST /stores/{store}/imports (multipart: file, type) */
    public function store(Request $request, Store $store): JsonResponse
    {
        $this->authorize($store);
        $file = $request->file('file');
        if ($file instanceof UploadedFile && $file->isValid() && (int) $file->getSize() > CsvInspector::MAX_BYTES) {
            throw new ApiException(413, 'payload_too_large', 'The file is larger than 10 MB.');
        }
        if ($file instanceof UploadedFile && $file->getError() === UPLOAD_ERR_INI_SIZE) {
            throw new ApiException(413, 'payload_too_large', 'The file is larger than 10 MB.');
        }
        $input = $request->validate([
            'type' => ['required', 'string', 'in:products,customers,suppliers'],
            'file' => ['required', 'file'],
        ]);
        $this->authorizeType($input['type']);
        $this->assertNoActiveImport($store);

        $info = CsvInspector::inspect($file->getRealPath(), (int) $file->getSize());

        $id = strtolower((string) Str::ulid());
        $path = $this->storage->importPath($id);
        $in = fopen($file->getRealPath(), 'rb');
        $this->storage->privateDisk()->writeStream($path, $in);
        if (is_resource($in)) {
            fclose($in);
        }

        $filename = trim((string) preg_replace('/[^\w .()-]+/u', '_', $file->getClientOriginalName()));
        $import = new DataImport([
            'type' => $input['type'],
            'status' => DataImport::UPLOADED,
            'file_path' => $path,
            'filename' => mb_substr($filename !== '' ? $filename : 'import.csv', 0, 255),
            'size_bytes' => (int) $file->getSize(),
            'checksum' => hash_file('sha256', $file->getRealPath()),
            'delimiter' => $info['delimiter'],
            'headers' => $info['headers'],
            'samples' => $info['samples'],
            'options' => DataImport::DEFAULT_OPTIONS,
            'row_count' => $info['row_count'],
            'created_by' => $request->user()?->getKey(),
        ]);
        $import->id = $id;
        $import->store_id = $store->id;
        $import->save();

        return new JsonResponse(['data' => DataTransferPresenter::import($import->load('createdBy'))], 201);
    }

    public function show(Store $store, DataImport $import): JsonResponse
    {
        $this->authorize($store);

        return new JsonResponse(['data' => DataTransferPresenter::import($import->load('createdBy'))]);
    }

    /** POST /stores/{store}/imports/{import}/validate */
    public function validateImport(Request $request, Store $store, DataImport $import): JsonResponse
    {
        $this->authorize($store);
        $this->authorizeType($import->type);
        $fields = ImportColumns::fields($import->type);
        $input = $request->validate([
            'column_map' => ['required', 'array'],
            'column_map.*' => ['nullable', 'string', 'in:'.implode(',', $fields)],
            'options' => ['required', 'array'],
            'options.update_existing' => ['required', 'boolean:strict'],
            'options.import_as_draft' => ['required', 'boolean:strict'],
            'options.create_missing_categories' => ['required', 'boolean:strict'],
        ], ['column_map.*.in' => 'Unknown field.']);

        if (! in_array($import->status, [DataImport::UPLOADED, DataImport::VALIDATED], true)) {
            throw $this->invalidState();
        }

        $map = [];
        $errors = [];
        $seen = [];
        foreach ($input['column_map'] as $header => $field) {
            if (! in_array($header, $import->headers, true)) {
                $errors["column_map.{$header}"] = ['This column is not in the file.'];

                continue;
            }
            if ($field !== null && isset($seen[$field])) {
                $errors["column_map.{$header}"] = ["\"{$field}\" is already matched to \"{$seen[$field]}\"."];
            }
            if ($field !== null) {
                $seen[$field] = $header;
            }
            $map[$header] = $field;
        }
        $required = $import->type === DataImport::PRODUCTS ? ['name', 'price'] : ['name']; // suppliers: name (P88B-15)
        foreach ($required as $field) {
            if (! isset($seen[$field])) {
                $errors['column_map'][] = "Match a column to \"{$field}\".";
            }
        }
        if ($import->type === DataImport::CUSTOMERS && ! isset($seen['phone']) && ! isset($seen['email'])) {
            $errors['column_map'][] = 'Match a column to "phone" or "email".';
        }
        if ($errors !== []) {
            throw ValidationException::withMessages($errors);
        }

        foreach ($import->headers as $header) {
            $map[$header] ??= null;
        }
        $this->assertNoActiveImport($store, $import->id);
        $this->transition($import, DataImport::VALIDATING, [
            'column_map' => $map,
            'options' => $input['options'],
            'summary' => null,
            'processed_rows' => 0,
            'validated_at' => null,
            'failure_reason' => null,
        ]);

        ValidateImport::dispatch($import->id)->forTenant($import->tenant_id);

        return new JsonResponse(['data' => DataTransferPresenter::import($import->refresh()->load('createdBy'))], 202);
    }

    /** GET /stores/{store}/imports/{import}/rows */
    public function rows(Request $request, Store $store, DataImport $import): JsonResponse
    {
        $this->authorize($store);
        $input = $request->validate([
            'filter' => ['sometimes', 'array:status'],
            'filter.status' => ['sometimes', 'string', 'regex:/^(ready|warning|error)(,(ready|warning|error))*$/'],
            'page' => ['sometimes', 'integer', 'min:1'],
            'per_page' => ['sometimes', 'integer', 'min:1', 'max:100'],
        ]);
        $this->assertValidated($import);

        $paginator = DataImportRow::query()->where('import_id', $import->id)
            ->when(isset($input['filter']['status']), fn ($q) => $q->whereIn('status', explode(',', $input['filter']['status'])))
            ->orderBy('row_number')
            ->paginate((int) ($input['per_page'] ?? 50));

        return new JsonResponse([
            'data' => $paginator->getCollection()->map(fn (DataImportRow $r) => DataTransferPresenter::row($r))->all(),
            'meta' => [
                'current_page' => $paginator->currentPage(),
                'per_page' => $paginator->perPage(),
                'total' => $paginator->total(),
                'last_page' => $paginator->lastPage(),
            ],
        ]);
    }

    /** GET /stores/{store}/imports/{import}/error-report — original columns + `errors`, formula-safe. */
    public function errorReport(Store $store, DataImport $import): Response
    {
        $this->authorize($store);
        $this->assertValidated($import);

        $problems = DataImportRow::query()->where('import_id', $import->id)->whereIn('status', ['warning', 'error'])
            ->orderBy('row_number')->get(['row_number', 'messages'])->keyBy('row_number');

        $writer = CsvWriter::toString();
        $writer->insertOne([...$import->headers, 'errors']);
        if ($problems->isNotEmpty()) {
            ImportFile::withLocalPath($import, function (string $path) use ($import, $problems, $writer) {
                foreach (ImportFile::raw($path, $import) as $rowNumber => $record) {
                    $row = $problems->get($rowNumber);
                    if ($row === null) {
                        continue;
                    }
                    $cells = [];
                    foreach ($import->headers as $i => $header) {
                        $cells[] = CsvCell::unescape((string) ($record[$i] ?? ''));
                    }
                    $cells[] = implode(' · ', array_map(fn ($m) => ucfirst($m['level']).': '.$m['message'], $row->messages ?? []));
                    $writer->insertOne($cells);
                }
            });
        }

        $name = pathinfo($import->filename, PATHINFO_FILENAME) ?: 'import';

        return new Response($writer->toString(), 200, [
            'Content-Type' => 'text/csv; charset=utf-8',
            'Content-Disposition' => 'attachment; filename="'.addcslashes($name, '"\\').'-errors.csv"',
            'Cache-Control' => 'no-store',
        ]);
    }

    /** POST /stores/{store}/imports/{import}/run */
    public function run(Request $request, Store $store, DataImport $import): JsonResponse
    {
        $this->authorize($store);
        $this->authorizeType($import->type);
        $input = $request->validate(['allow_partial' => ['sometimes', 'boolean:strict']]);
        if ($import->status !== DataImport::VALIDATED) {
            throw $this->invalidState();
        }
        if ($import->type === DataImport::PRODUCTS && ! $this->context->allows(Permission::CostsView) && $this->setsCost($import)) {
            throw new ApiException(403, 'forbidden', 'You do not have permission to change cost prices. Remove the cost column or ask the owner.');
        }

        if ($import->type === DataImport::PRODUCTS && ! ($input['allow_partial'] ?? false)) {
            $tenant = $this->context->tenant();
            $limit = FeatureGate::limit($tenant, Limit::Products);
            $creates = (int) ($import->summary['create_products'] ?? 0);
            if ($limit !== null) {
                $room = max(0, $limit - FeatureGate::usage($tenant, Limit::Products));
                if ($creates > $room) {
                    $message = "Your plan has room for {$room} more products; this file creates {$creates}.";
                    throw new ApiException(402, 'plan_limit_reached', $message, ['products' => [$message]]);
                }
            }
        }

        $this->assertNoActiveImport($store, $import->id);
        $this->transition($import, DataImport::IMPORTING, ['processed_rows' => 0, 'started_at' => now()]);
        RunImport::dispatch($import->id)->forTenant($import->tenant_id);

        return new JsonResponse(['data' => DataTransferPresenter::import($import->refresh()->load('createdBy'))], 202);
    }

    /** DELETE /stores/{store}/imports/{import} — cancels and deletes the file. */
    public function destroy(Store $store, DataImport $import): Response
    {
        $this->authorize($store);
        if ($import->isActive()) {
            throw $this->invalidState();
        }
        if ($this->storage->ownsPath($import->file_path)) {
            $this->storage->privateDisk()->delete($import->file_path);
        }
        $import->forceFill(['status' => DataImport::CANCELLED])->save();

        return response()->noContent();
    }

    private function authorize(Store $store): void
    {
        Gate::authorize('view', $store);
        if (! Gate::allows('data.import')) {
            throw new ApiException(403, 'forbidden', 'You do not have permission to import data.');
        }
    }

    /**
     * PHASE-8-3 §3.2 (SEC-M2): `data.import` alone must not get around the keys of what the file writes. A product
     * import needs `products.edit` and `inventory.adjust` (+ `costs.view` when a row sets a cost, checked on run); a
     * customer import needs `customers.edit`. Denied → 403 `forbidden`, like the `perm:` middleware.
     */
    private function authorizeType(string $type): void
    {
        $needs = match ($type) {
            DataImport::PRODUCTS => [Permission::ProductsEdit, Permission::InventoryAdjust],
            DataImport::SUPPLIERS => [Permission::PurchasingManage], // PHASE-8-8B P88B-15 (+ plan `purchasing`, below)
            default => [Permission::CustomersEdit],
        };
        foreach ($needs as $permission) {
            if (! $this->context->allows($permission)) {
                throw new ApiException(403, 'forbidden', 'You do not have permission to do this.');
            }
        }
        if ($type === DataImport::SUPPLIERS) {
            FeatureGate::assertAllows($this->context->tenant(), Feature::Purchasing);
        }
    }

    /** Does any row that will be written carry a cost price? */
    private function setsCost(DataImport $import): bool
    {
        foreach (DataImportRow::query()->where('import_id', $import->id)->where('status', '!=', 'error')->lazyById(500) as $row) {
            if (($row->values['variant']['cost_amount'] ?? null) !== null) {
                return true;
            }
        }

        return false;
    }

    private function assertNoActiveImport(Store $store, ?string $except = null): void
    {
        $busy = DataImport::query()->where('store_id', $store->id)
            ->whereIn('status', [DataImport::VALIDATING, DataImport::IMPORTING])
            ->when($except, fn ($q) => $q->whereKeyNot($except))->exists();
        if ($busy) {
            throw new ApiException(409, 'import_in_progress', 'Another import is running. Wait for it to finish.');
        }
    }

    private function assertValidated(DataImport $import): void
    {
        if (! in_array($import->status, [DataImport::VALIDATED, DataImport::IMPORTING, DataImport::COMPLETED], true)) {
            throw new ApiException(409, 'invalid_state_transition', 'Check the file first.');
        }
    }

    /** @param array<string, mixed> $values */
    private function transition(DataImport $import, string $status, array $values): void
    {
        try {
            $import->forceFill(['status' => $status] + $values)->save();
        } catch (QueryException) {
            // data_imports_one_active: a parallel request won the race.
            throw new ApiException(409, 'import_in_progress', 'Another import is running. Wait for it to finish.');
        }
    }

    private function invalidState(): ApiException
    {
        return new ApiException(409, 'invalid_state_transition', 'This import can’t do that in its current state.');
    }
}
