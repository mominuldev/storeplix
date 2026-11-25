<?php

namespace App\Domain\Documents\Http;

use App\Domain\Documents\DocumentRenderer;
use App\Domain\Documents\Jobs\RenderDocument;
use App\Domain\Documents\Models\Document;
use App\Domain\Documents\Models\DocumentTemplate;
use App\Domain\Documents\TemplateConfig;
use App\Domain\Media\TenantStorage;
use App\Domain\Orders\Models\Order;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Shared\Http\UserRef;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\TenantContext;
use App\Domain\Themes\StoreThemeService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\DB;
use Illuminate\Support\Facades\Gate;
use Illuminate\Support\Facades\URL;
use Illuminate\Validation\Rule;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpFoundation\StreamedResponse;

/**
 * Documents (PHASE-5B §4.8, §7): template options (read O A S, write O A `ManageSettings`), queued generation,
 * status + 5-minute signed download (S35), Live preview HTML (sanitised; shown in a sandboxed iframe).
 */
class DocumentController
{
    public function __construct(
        private readonly DocumentRenderer $renderer,
        private readonly TenantContext $context,
    ) {}

    public function templates(Store $store): JsonResponse
    {
        Gate::authorize('view', $store);
        $rows = DocumentTemplate::query()->where('store_id', $store->id)->get()->keyBy('kind');

        return new JsonResponse(['data' => array_map(fn (string $kind) => TemplateConfig::present($kind, $rows[$kind] ?? null), TemplateConfig::KINDS)]);
    }

    public function updateTemplate(Request $request, Store $store, string $kind): JsonResponse
    {
        Gate::authorize('update', $store); // O A (ManageSettings)
        $input = $request->validate(['revision' => ['sometimes', 'integer:strict', 'min:0'], ...TemplateConfig::rules()]);

        $row = DB::transaction(function () use ($store, $kind, $input, $request) {
            $row = DocumentTemplate::query()->where('store_id', $store->id)->where('kind', $kind)->lockForUpdate()->first();
            if (array_key_exists('revision', $input) && (int) $input['revision'] !== ($row?->revision ?? 0)) {
                throw StoreThemeService::conflict();
            }
            if ($row === null) {
                $row = new DocumentTemplate;
                $row->store_id = $store->id;
                $row->kind = $kind;
                $row->revision = 1;
            } else {
                $row->revision++;
            }
            $row->config = TemplateConfig::normalise($kind, $input['config']);
            $row->updated_by = $request->user()?->getKey();
            $row->save();

            return $row;
        });

        return new JsonResponse(['data' => TemplateConfig::present($kind, $row)]);
    }

    public function store(Request $request, Store $store): JsonResponse
    {
        Gate::authorize('view', $store);
        $max = (int) config('documents.max_orders', 100);
        $input = $request->validate([
            'kind' => ['required', 'string', Rule::in(TemplateConfig::KINDS)],
            'order_ids' => ['required', 'array', 'min:1', 'max:'.$max],
            'order_ids.*' => ['required', 'string', 'max:26', 'distinct:ignore_case'],
            'language' => ['sometimes', 'string', 'in:en,bn'],
        ]);
        $ids = array_map('strtolower', array_values($input['order_ids']));
        $known = Order::query()->where('store_id', $store->id)->whereIn('id', $ids)->pluck('created_via', 'id');
        $errors = [];
        foreach ($ids as $i => $id) {
            if (! isset($known[$id])) {
                $errors["order_ids.{$i}"] = ['Unknown order.'];
            } elseif ($input['kind'] === 'label_4x6' && $known[$id] === Order::VIA_POS) {
                $errors["order_ids.{$i}"] = ['A till sale has no shipping label.']; // PHASE-8-8D §8 (S205)
            }
        }
        if ($errors !== []) {
            throw ValidationException::withMessages($errors);
        }
        $language = $input['language'] ?? TemplateConfig::normalise($input['kind'], DocumentTemplate::query()->where('store_id', $store->id)->where('kind', $input['kind'])->value('config'))['language'];

        $document = DB::transaction(function () use ($store, $input, $ids, $language, $request) {
            if (DB::getDriverName() === 'pgsql') {
                DB::select('SELECT pg_advisory_xact_lock(hashtextextended(?, 0))', ['documents:'.$store->id]);
            }
            $busy = Document::query()->where('store_id', $store->id)->whereIn('status', [Document::QUEUED, Document::RENDERING])->count();
            if ($busy >= (int) config('documents.max_queued', 10)) {
                throw new ApiException(409, 'conflict', 'Too many documents are being prepared. Wait for them to finish.');
            }
            $document = new Document;
            $document->store_id = $store->id;
            $document->kind = $input['kind'];
            $document->order_ids = $ids;
            $document->language = $language;
            $document->status = Document::QUEUED;
            $document->created_by = $request->user()?->getKey();
            $document->save();
            RenderDocument::dispatch($document->id)->afterCommit();

            return $document;
        });

        return new JsonResponse(['data' => self::present($document->refresh())], 202);
    }

    public function show(Store $store, Document $document): JsonResponse
    {
        Gate::authorize('view', $store);

        return new JsonResponse(['data' => self::present($document)]);
    }

    public function preview(Request $request, Store $store): JsonResponse
    {
        Gate::authorize('view', $store);
        $input = $request->validate([
            'kind' => ['required', 'string', Rule::in(TemplateConfig::KINDS)],
            ...TemplateConfig::rules('config', required: false),
            'order_id' => ['sometimes', 'nullable', 'string', 'max:26'],
        ]);
        $kind = $input['kind'];
        $config = TemplateConfig::normalise($kind, $input['config']
            ?? DocumentTemplate::query()->where('store_id', $store->id)->where('kind', $kind)->value('config'));
        if (($input['order_id'] ?? null) !== null) {
            $order = Order::query()->where('store_id', $store->id)->whereKey(strtolower($input['order_id']))->with('items')->first()
                ?? throw ValidationException::withMessages(['order_id' => ['Unknown order.']]);
        } else {
            $order = $this->renderer->sample($store);
        }
        $store->loadMissing('primaryDomain');
        $html = $this->renderer->html($kind, collect([$order]), $store, $config, $config['language'], embedFonts: false);

        return new JsonResponse(['data' => ['html' => $html]]);
    }

    /** GET /documents/{document}/download (signed, 5 minutes). Tenant comes from the signed URL; S35. */
    public function download(Request $request, string $document, TenantStorage $storage): StreamedResponse
    {
        return $this->context->run((string) $request->query('tenant'), function () use ($document, $storage) {
            /** @var Document|null $model */
            $model = Document::query()->whereKey(strtolower($document))->first();
            if ($model === null || $model->status !== Document::READY || $model->isExpired() || $model->file_path === null || ! $storage->ownsPath($model->file_path)) {
                throw new ApiException(404, 'not_found', 'Resource not found.');
            }
            $html = str_ends_with($model->file_path, '.html');
            $headers = [
                'Content-Type' => $html ? 'text/html; charset=utf-8' : 'application/pdf',
                'Cache-Control' => 'private, no-store',
                'X-Content-Type-Options' => 'nosniff',
            ];
            if ($html) {
                // `html` driver output (local / CI only): never runs script, never loads anything.
                $headers['Content-Security-Policy'] = "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:";
            }

            return $storage->privateDisk()->response($model->file_path, self::filename($model, $html ? 'html' : 'pdf'), $headers, 'inline');
        });
    }

    /** @return array<string, mixed> StoreDocument (download_url is a fresh 5-minute signed URL each call) */
    public static function present(Document $d): array
    {
        $expired = $d->isExpired();
        $ready = $d->status === Document::READY && ! $expired;

        return [
            'id' => $d->id,
            'kind' => $d->kind,
            'status' => $expired ? Document::EXPIRED : $d->status,
            'orders_count' => count($d->order_ids ?? []),
            'pages' => $d->pages,
            'download_url' => $ready ? URL::temporarySignedRoute('documents.download', now()->addMinutes((int) config('documents.download_minutes', 5)), ['document' => $d->id, 'tenant' => $d->tenant_id]) : null,
            'expires_at' => UserRef::iso($d->expires_at),
            'error_code' => $d->error_code,
            'created_at' => UserRef::iso($d->created_at),
        ];
    }

    /** "GS-1042-label.pdf" for one order, "labels-12-orders.pdf" for a batch. */
    public static function filename(Document $d, string $extension): string
    {
        $suffix = match ($d->kind) {
            'label_4x6' => 'label', 'receipt_80mm' => 'receipt', 'packing_slip' => 'packing-slip', 'invoice_a5_two_up' => 'invoice-a5', default => 'invoice',
        };
        $ids = $d->order_ids ?? [];
        if (count($ids) === 1) {
            $number = Order::query()->whereKey($ids[0])->value('number');
            if (is_string($number) && preg_match('/^[A-Za-z0-9-]+$/', $number) === 1) {
                return "{$number}-{$suffix}.{$extension}";
            }
        }

        return $suffix.'s-'.count($ids).'-orders.'.$extension;
    }
}
