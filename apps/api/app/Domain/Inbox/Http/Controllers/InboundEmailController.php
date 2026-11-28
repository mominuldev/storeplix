<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Http\Controllers;

use App\Domain\Inbox\Inbound\FakeInboundDriver;
use App\Domain\Inbox\Inbound\InboundMailDriver;
use App\Domain\Inbox\Inbound\MailgunInboundDriver;
use App\Domain\Inbox\InboxAttachments;
use App\Domain\Inbox\Jobs\ProcessInboundEmail;
use App\Domain\Inbox\Models\InboxAttachment;
use App\Domain\Inbox\Support\InboundRouter;
use App\Domain\Inbox\Support\ReplyAddress;
use App\Domain\Shared\Http\ApiException;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\TenantContext;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;

/**
 * POST /api/v1/webhooks/inbound-email/{driver} (PHASE-8-8E §11.2, S243). Public. 1) driver signature + timestamp +
 * replay → else 401 `inbound_email_signature_invalid`, nothing stored; 2) the first recipient on the mail domain
 * decides the target — none / unknown key / bad sig → 202 `accepted: false` (no bounce, no oracle); 3) tenant + store
 * through InboundRouter, then inside the tenant: ≤ 3 sniffed attachments stored, the rest counted as rejected, and
 * ProcessInboundEmail queued with the parsed text only (raw MIME is never stored).
 */
class InboundEmailController
{
    public function __construct(
        private readonly InboundRouter $router,
        private readonly TenantContext $context,
        private readonly InboxAttachments $attachments,
    ) {}

    public static function driver(string $name): ?InboundMailDriver
    {
        if ($name !== (string) config('inbox.inbound_driver') || ($name === 'fake' && app()->environment('production'))) {
            return null;
        }

        return match ($name) {
            'mailgun' => new MailgunInboundDriver,
            'fake' => new FakeInboundDriver,
            default => null,
        };
    }

    public function __invoke(Request $request, string $driver): JsonResponse
    {
        $impl = self::driver($driver) ?? throw new ApiException(404, 'not_found', 'Resource not found.');
        if (! $impl->verify($request)) {
            throw new ApiException(401, 'inbound_email_signature_invalid', 'Invalid signature.');
        }
        $mail = $impl->parse($request);
        $target = ReplyAddress::target($mail->recipients);
        $route = $target === null ? null : $this->router->route($target['kind'], $target['key']);
        if ($route === null) {
            return self::ack(false);
        }

        $this->context->run($route['tenant_id'], function () use ($route, $target, $mail) {
            $store = Store::query()->find($route['store_id']);
            if ($store === null) {
                return;
            }
            $ids = [];
            $rejected = 0;
            foreach ($mail->attachments as $file) {
                $info = count($ids) < InboxAttachments::MAX_PER_MESSAGE ? $this->attachments->inspect($file) : 'too many';
                if (is_string($info)) {
                    $rejected++;

                    continue;
                }
                $ids[] = $this->attachments->store($file, $info, $store, InboxAttachment::BY_EMAIL)->id;
            }
            ProcessInboundEmail::dispatch($store->id, [
                'kind' => $target['kind'],
                'target_id' => $route['target_id'],
                'from' => $mail->from,
                'from_name' => $mail->fromName !== null ? mb_substr($mail->fromName, 0, 120) : null,
                'subject' => mb_substr($mail->subject, 0, 300),
                'text' => mb_substr($mail->text, 0, 100_000),
                'html' => $mail->html !== null ? mb_substr($mail->html, 0, 200_000) : null,
                'message_id' => $mail->messageId,
                'in_reply_to' => $mail->inReplyTo,
                'authenticated' => $mail->authenticated,
                'auto' => $mail->auto,
            ], $ids, $rejected)->forTenant($route['tenant_id']);
        });

        return self::ack(true);
    }

    private static function ack(bool $accepted): JsonResponse
    {
        return new JsonResponse(['data' => ['received' => true, 'accepted' => $accepted]], 202);
    }
}
