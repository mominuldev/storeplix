<?php

namespace App\Domain\Documents\Jobs;

use App\Domain\Documents\DocumentRenderer;
use App\Domain\Documents\Drivers\DocumentDriver;
use App\Domain\Documents\Drivers\DocumentRenderFailed;
use App\Domain\Documents\Models\Document;
use App\Domain\Documents\Models\DocumentTemplate;
use App\Domain\Documents\TemplateConfig;
use App\Domain\Media\TenantStorage;
use App\Domain\Orders\Models\Order;
use App\Domain\Orders\OrderTimeline;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Queue\TenantAware;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Log;
use Throwable;

/**
 * Renders one document on the `documents` queue (P5B-53): HTML → driver → private disk
 * `tenants/{tenant}/invoices/{id}.{pdf|html}`, 24 h. Marks the orders printed (invoice / label) and adds a
 * `document` order event. The last failed try leaves the document `failed` with an error code.
 */
class RenderDocument implements ShouldQueue
{
    use Queueable, TenantAware;

    public const QUEUE = 'documents';

    public int $timeout = 120;

    public int $tries = 2;

    public function __construct(public readonly string $documentId)
    {
        $this->onQueue(self::QUEUE);
    }

    public function handle(DocumentRenderer $renderer, DocumentDriver $driver, TenantStorage $storage): void
    {
        $document = Document::query()->find($this->documentId);
        if ($document === null || ! in_array($document->status, [Document::QUEUED, Document::RENDERING], true)) {
            return;
        }
        $document->forceFill(['status' => Document::RENDERING])->save();

        try {
            $store = Store::query()->with('primaryDomain')->findOrFail($document->store_id);
            $ids = $document->order_ids;
            $orders = Order::query()->where('store_id', $store->id)->whereIn('id', $ids)->with('items')->get()->keyBy('id');
            $ordered = collect($ids)->map(fn (string $id) => $orders[$id] ?? null)->filter()->values();
            $template = DocumentTemplate::query()->where('store_id', $store->id)->where('kind', $document->kind)->first();
            $config = TemplateConfig::normalise($document->kind, $template?->config);

            $html = $renderer->html($document->kind, $ordered, $store, $config, $document->language, embedFonts: true);
            $file = $driver->render($html, $document->kind);
            $path = 'tenants/'.$document->tenant_id.'/invoices/'.$document->id.'.'.$file['extension'];
            $storage->privateDisk()->put($path, $file['bytes']);

            $document->forceFill([
                'status' => Document::READY,
                'file_path' => $path,
                'bytes' => strlen($file['bytes']),
                'pages' => $file['pages'] ?? DocumentRenderer::pages($document->kind, $ordered->count()),
                'error_code' => null,
                'expires_at' => now()->addHours((int) config('documents.ttl_hours', 24)),
            ])->save();
            $this->markPrinted($document, $ordered->all());
        } catch (Throwable $e) {
            $code = $e instanceof DocumentRenderFailed ? $e->errorCode : 'render_failed';
            Log::warning('documents.render_failed', ['document_id' => $document->id, 'kind' => $document->kind, 'code' => $code, 'attempt' => $this->attempts()]);
            // The sync queue (tests, `QUEUE_CONNECTION=sync`) never retries: the first failure is final.
            if ($this->attempts() < $this->tries && $this->job !== null && $this->job->getConnectionName() !== 'sync') {
                $document->forceFill(['status' => Document::QUEUED])->save();
                throw $e;
            }
            $document->forceFill(['status' => Document::FAILED, 'error_code' => $code])->save();
        }
    }

    /** @param list<Order> $orders */
    private function markPrinted(Document $document, array $orders): void
    {
        $column = match (true) {
            in_array($document->kind, TemplateConfig::INVOICE_KINDS, true) => 'invoice_printed_at',
            $document->kind === 'label_4x6' => 'label_printed_at',
            default => null,
        };
        $now = now();
        if ($column !== null && $orders !== []) {
            Order::query()->whereIn('id', array_map(fn (Order $o) => $o->id, $orders))->update([$column => $now, 'updated_at' => $now]);
        }
        foreach ($orders as $order) {
            OrderTimeline::record($order, 'document', null, null, ['kind' => $document->kind, 'document_id' => $document->id]);
        }
    }

    public function attempts(): int
    {
        return $this->job?->attempts() ?? 1;
    }
}
