<?php

namespace App\Domain\DataTransfer\Jobs;

use App\Domain\Billing\Exceptions\PlanLimitReached;
use App\Domain\Catalog\CategoryService;
use App\Domain\Catalog\Models\Category;
use App\Domain\Catalog\Models\Product;
use App\Domain\Catalog\ProductService;
use App\Domain\Catalog\Support\Slug;
use App\Domain\Customers\CustomerService;
use App\Domain\Customers\Models\Customer;
use App\Domain\DataTransfer\Models\DataImport;
use App\Domain\DataTransfer\Models\DataImportRow;
use App\Domain\Identity\Models\User;
use App\Domain\Purchasing\Models\Supplier;
use App\Domain\Purchasing\SupplierService;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Stores\Revalidation\StorefrontRevalidation;
use App\Domain\Stores\Revalidation\StorefrontRevalidationObserver;
use App\Domain\Tenancy\Queue\TenantAware;
use App\Domain\Tenancy\Support\AuditLogger;
use App\Domain\Tenancy\Support\TenantCache;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Cache;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Log;
use Illuminate\Validation\ValidationException;
use Throwable;

/**
 * Run (§5.4): applies ready/warning rows (action create|update) in chunks of ~200 rows, one transaction per chunk,
 * with the storefront observer muted; one RevalidateStorefront at the end when any touched product is/was active.
 * A product whose create fails (plan limit, SKU taken meanwhile) marks all of its rows `error`.
 */
class RunImport implements ShouldQueue
{
    use Queueable, TenantAware;

    public int $timeout = 300;

    public int $tries = 1;

    private bool $touchedActive = false;

    /** @var array<string, string> lower path → category id (created during this run) */
    private array $createdCategories = [];

    public function __construct(public readonly string $importId)
    {
        $this->onQueue('bulk');
    }

    public function handle(TenantCache $cache, ProductService $products, CustomerService $customers, CategoryService $categories, AuditLogger $audit, SupplierService $suppliers): void
    {
        $import = DataImport::query()->find($this->importId);
        if ($import === null || $import->status !== DataImport::IMPORTING) {
            return;
        }
        $store = Store::query()->findOrFail($import->store_id);
        $user = $import->created_by ? User::query()->find($import->created_by) : null;

        $lock = Cache::lock($cache->key("import:{$store->id}"), 600);
        if (! $lock->block(10)) {
            throw new \RuntimeException('Import lock busy.');
        }

        try {
            StorefrontRevalidation::muted(function () use ($import, $store, $user, $products, $customers, $categories, $suppliers) {
                $rows = DataImportRow::query()->where('import_id', $import->id)
                    ->whereIn('status', ['ready', 'warning'])->whereIn('action', ['create', 'update'])
                    ->orderBy('row_number')->get();
                $processed = 0;
                foreach ($this->chunks($rows->all(), $import->type) as $chunk) {
                    DB::transaction(function () use ($chunk, $import, $store, $user, $products, $customers, $categories, $suppliers) {
                        if ($import->type === DataImport::PRODUCTS) {
                            foreach ($this->groups($chunk) as $group) {
                                $this->product($group, $import, $store, $user, $products, $categories);
                            }
                        } elseif ($import->type === DataImport::SUPPLIERS) {
                            foreach ($chunk as $row) {
                                $this->supplier($row, $store, $user, $suppliers);
                            }
                        } else {
                            foreach ($chunk as $row) {
                                $this->customer($row, $store, $user, $customers);
                            }
                        }
                    });
                    $processed += count($chunk);
                    $import->forceFill(['processed_rows' => $processed])->save();
                }
            });

            $summary = $this->finalSummary($import);
            $import->forceFill(['status' => DataImport::COMPLETED, 'completed_at' => now(), 'summary' => $summary])->save();
            $auditSummary = array_intersect_key($summary, array_flip(['total', 'create', 'update', 'unchanged', 'warnings', 'errors', 'over_limit']));
            $audit->log('import.run', $import, ['type' => $import->type, 'summary' => $auditSummary], $user, system: $user === null);
            if ($import->type === DataImport::SUPPLIERS) {
                $audit->log('purchasing.suppliers_imported', $import, ['summary' => $auditSummary], $user, system: $user === null); // P88B-18
            }

            if ($this->touchedActive) {
                app(StorefrontRevalidationObserver::class)->dispatch($store->tenant_id, $store->id);
            }
        } finally {
            $lock->release();
        }
    }

    /**
     * Chunks of ≥ 200 rows that never split a product group.
     *
     * @param  list<DataImportRow>  $rows
     * @return iterable<list<DataImportRow>>
     */
    private function chunks(array $rows, string $type): iterable
    {
        $chunk = [];
        $lastGroup = null;
        foreach ($rows as $row) {
            $group = $type === DataImport::PRODUCTS ? ($row->values['group'] ?? null) : null;
            if (count($chunk) >= 200 && ($type !== DataImport::PRODUCTS || $group !== $lastGroup)) {
                yield $chunk;
                $chunk = [];
            }
            $chunk[] = $row;
            $lastGroup = $group;
        }
        if ($chunk !== []) {
            yield $chunk;
        }
    }

    /**
     * @param  list<DataImportRow>  $rows
     * @return list<list<DataImportRow>>
     */
    private function groups(array $rows): array
    {
        $groups = [];
        foreach ($rows as $row) {
            $groups[$row->values['group']][] = $row;
        }

        return array_values($groups);
    }

    /** @param list<DataImportRow> $rows */
    private function product(array $rows, DataImport $import, Store $store, ?User $user, ProductService $products, CategoryService $categories): void
    {
        $first = $rows[0];
        $reference = ['type' => 'import', 'id' => $import->id];
        $options = $import->options + DataImport::DEFAULT_OPTIONS;

        try {
            DB::transaction(function () use ($rows, $first, $store, $user, $products, $categories, $reference, $options) {
                if ($first->action === 'create') {
                    $p = $first->values['product'];
                    $optionNames = $first->values['option_names'] ?? [];
                    $values = [];
                    foreach ($rows as $row) {
                        foreach ($row->values['option_values'] as $k => $value) {
                            if (! in_array(mb_strtolower($value), array_map('mb_strtolower', $values[$k] ?? []), true)) {
                                $values[$k][] = $value;
                            }
                        }
                    }
                    $plan = [
                        'fields' => [
                            'name' => $p['name'],
                            'status' => $options['import_as_draft'] ? Product::DRAFT : ($p['status'] ?? Product::ACTIVE),
                            'description' => $p['description'],
                            'tags' => $p['tags'] ?? [],
                            'seo_title' => $p['seo_title'],
                            'seo_description' => $p['seo_description'],
                        ],
                        'options' => array_map(fn ($name, $k) => ['name' => $name, 'values' => $values[$k] ?? []], $optionNames, array_keys($optionNames)),
                        'variants' => array_map(fn (DataImportRow $row, int $i) => [
                            'id' => null,
                            'option_values' => $row->values['option_values'],
                            'sku' => $row->values['variant']['sku'],
                            'barcode' => $row->values['variant']['barcode'],
                            'price_amount' => $row->values['variant']['price_amount'],
                            'compare_at_amount' => $row->values['variant']['compare_at_amount'],
                            'cost_amount' => $row->values['variant']['cost_amount'],
                            'weight_grams' => $row->values['variant']['weight_grams'],
                            'initial_on_hand' => (int) ($row->values['variant']['stock'] ?? 0),
                            'position' => $i,
                        ], $rows, array_keys($rows)),
                        'images' => [],
                        'category_ids' => $this->categoryIds($store, $p, $options, $user, $categories),
                    ];
                    $product = $products->create($store, $plan, $user, [
                        'reason' => 'import', 'reference' => $reference, 'audit' => false,
                        'slug_base' => $p['handle'] ?? Slug::from((string) $p['name'], 'p', 220),
                    ]);
                    $this->touchedActive = $this->touchedActive || $product->isActive();
                    $this->result($rows, $product->id);

                    return;
                }

                $product = Product::query()->where('store_id', $store->id)->find($first->values['target_product_id']);
                if ($product === null) {
                    throw new ApiException(422, 'validation_failed', 'This product was deleted after the check.');
                }
                $wasActive = $product->isActive();
                $productFields = null;
                $categoryIds = null;
                $firstRow = collect($rows)->first(fn (DataImportRow $r) => $r->values['first'] ?? false);
                if ($firstRow !== null && $options['update_existing']) {
                    $p = $firstRow->values['product'];
                    $productFields = array_filter([
                        'name' => $p['name'], 'status' => $p['status'], 'description' => $p['description'], 'tags' => $p['tags'],
                        'seo_title' => $p['seo_title'], 'seo_description' => $p['seo_description'],
                    ], fn ($v) => $v !== null);
                    if ($p['category_ids'] !== null || $p['create_categories'] !== []) {
                        $categoryIds = $this->categoryIds($store, $p, $options, $user, $categories);
                    }
                }
                $variantFields = [];
                $stock = [];
                foreach ($rows as $row) {
                    $v = $row->values['variant'];
                    $variantFields[$row->values['target_variant_id']] = array_filter([
                        'price_amount' => $v['price_amount'], 'compare_at_amount' => $v['compare_at_amount'], 'cost_amount' => $v['cost_amount'],
                        'barcode' => $v['barcode'], 'weight_grams' => $v['weight_grams'],
                    ], fn ($x) => $x !== null);
                    if ($v['stock'] !== null) {
                        $stock[$row->values['target_variant_id']] = (int) $v['stock'];
                    }
                }
                $product = $products->importUpdate($store, $product, $productFields, $categoryIds, $variantFields, $stock, $user, $reference);
                $this->touchedActive = $this->touchedActive || $wasActive || $product->isActive();
                $this->result($rows, $product->id);
            });
        } catch (PlanLimitReached) {
            $this->fail_rows($rows, 'Your plan’s product limit is reached — this product was not imported.');
        } catch (ValidationException $e) {
            $this->fail_rows($rows, collect($e->errors())->flatten()->first() ?? 'This product could not be imported.');
        } catch (ApiException $e) {
            $this->fail_rows($rows, $e->getMessage());
        }
    }

    /**
     * Category ids for a product row; missing paths are created when `create_missing_categories` (depth/500 limits
     * apply; a refused path is skipped).
     *
     * @param  array<string, mixed>  $p
     * @param  array<string, bool>  $options
     * @return list<string>
     */
    private function categoryIds(Store $store, array $p, array $options, ?User $user, CategoryService $categories): array
    {
        $ids = $p['category_ids'] ?? [];
        if ($options['create_missing_categories']) {
            foreach ($p['create_categories'] ?? [] as $segments) {
                $parent = null;
                $path = [];
                foreach ($segments as $name) {
                    $path[] = mb_strtolower($name);
                    $key = implode(' > ', $path);
                    $id = $this->createdCategories[$key] ?? $this->findCategory($store, $parent, $name);
                    if ($id === null) {
                        try {
                            $id = $categories->create($store, ['name' => $name, 'parent_id' => $parent], $user)->id;
                        } catch (ApiException|ValidationException) {
                            $id = null;
                        }
                    }
                    if ($id === null) {
                        break;
                    }
                    $this->createdCategories[$key] = $id;
                    $parent = $id;
                }
                if ($parent !== null && count($path) === count($segments)) {
                    $ids[] = $parent;
                }
            }
        }

        return array_slice(array_values(array_unique($ids)), 0, Product::MAX_CATEGORIES);
    }

    private function findCategory(Store $store, ?string $parentId, string $name): ?string
    {
        return Category::query()->where('store_id', $store->id)
            ->when($parentId === null, fn ($q) => $q->whereNull('parent_id'), fn ($q) => $q->where('parent_id', $parentId))
            ->get(['id', 'name'])->first(fn (Category $c) => mb_strtolower($c->name) === mb_strtolower($name))?->id;
    }

    private function customer(DataImportRow $row, Store $store, ?User $user, CustomerService $customers): void
    {
        $v = $row->values['customer'];
        $fields = array_filter(array_intersect_key($v, array_flip(CustomerService::FIELDS)), fn ($x) => $x !== null);
        try {
            DB::transaction(function () use ($row, $store, $user, $customers, $v, $fields) {
                if ($row->action === 'create') {
                    $customer = $customers->create($store, $fields, $user, Customer::SOURCE_IMPORT);
                    if (($v['note'] ?? null) !== null) {
                        $customers->addNote($customer, $v['note'], $user);
                    }
                } else {
                    $customer = Customer::query()->where('store_id', $store->id)->find($row->values['target_id'])
                        ?? throw new ApiException(422, 'validation_failed', 'This customer was deleted after the check.');
                    $customer = $customers->update($store, $customer, $fields, null, $user);
                }
                $row->forceFill(['result_id' => $customer->id])->save();
            });
        } catch (ValidationException $e) {
            $this->fail_rows([$row], collect($e->errors())->flatten()->first() ?? 'This customer could not be imported.');
        } catch (ApiException $e) {
            $this->fail_rows([$row], $e->getMessage());
        }
    }

    /** PHASE-8-8B P88B-15: create or update one supplier (no per-row audit; the run is audited once). */
    private function supplier(DataImportRow $row, Store $store, ?User $user, SupplierService $suppliers): void
    {
        $fields = array_filter($row->values['supplier'], fn ($x) => $x !== null);
        try {
            DB::transaction(function () use ($row, $store, $user, $suppliers, $fields) {
                if ($row->action === 'create') {
                    $supplier = $suppliers->create($store, $fields, $user, audit: false);
                } else {
                    $supplier = Supplier::query()->where('store_id', $store->id)->find($row->values['target_id'])
                        ?? throw new ApiException(422, 'validation_failed', 'This supplier was deleted after the check.');
                    $supplier = $suppliers->update($store, $supplier, $fields, $user, audit: false);
                }
                $row->forceFill(['result_id' => $supplier->id])->save();
            });
        } catch (ValidationException $e) {
            $this->fail_rows([$row], collect($e->errors())->flatten()->first() ?? 'This supplier could not be imported.');
        } catch (ApiException $e) {
            $this->fail_rows([$row], $e->getMessage());
        }
    }

    /** @param list<DataImportRow> $rows */
    private function result(array $rows, string $id): void
    {
        DataImportRow::query()->whereIn('id', array_map(fn ($r) => $r->id, $rows))->update(['result_id' => $id]);
    }

    /** @param list<DataImportRow> $rows */
    private function fail_rows(array $rows, string $message): void
    {
        foreach ($rows as $row) {
            $messages = $row->messages ?? [];
            $messages[] = ['level' => 'error', 'field' => null, 'message' => $message];
            $row->forceFill(['status' => 'error', 'action' => 'skip', 'messages' => $messages])->save();
        }
    }

    /** @return array<string, int> */
    private function finalSummary(DataImport $import): array
    {
        $rows = DataImportRow::query()->where('import_id', $import->id)->get(['status', 'action']);
        $summary = $import->summary ?? [];
        $summary['total'] = $rows->count();
        $summary['create'] = $rows->where('status', '!=', 'error')->where('action', 'create')->count();
        $summary['update'] = $rows->where('status', '!=', 'error')->where('action', 'update')->count();
        $summary['unchanged'] = $rows->where('action', 'unchanged')->count();
        $summary['warnings'] = $rows->where('status', 'warning')->count();
        $summary['errors'] = $rows->where('status', 'error')->count();

        return $summary;
    }

    public function failed(?Throwable $e): void
    {
        Log::error('import.run_failed', ['import_id' => $this->importId, 'error' => $e?->getMessage()]);
        if ($this->tenantId !== null) {
            app(TenantContext::class)->run($this->tenantId, fn () => DataImport::query()->whereKey($this->importId)
                ->where('status', DataImport::IMPORTING)
                ->update(['status' => DataImport::FAILED, 'failure_reason' => 'The import stopped. Rows already imported were kept. Try again or contact support.', 'updated_at' => now()]));
        }
    }
}
