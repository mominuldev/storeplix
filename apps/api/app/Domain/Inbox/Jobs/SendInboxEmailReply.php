<?php

declare(strict_types=1);

namespace App\Domain\Inbox\Jobs;

use App\Domain\Inbox\Mail\InboxReplyMail;
use App\Domain\Inbox\Models\InboxAttachment;
use App\Domain\Inbox\Models\InboxConversation;
use App\Domain\Inbox\Models\InboxMessage;
use App\Domain\Inbox\Support\InboxText;
use App\Domain\Inbox\Support\InboxVersion;
use App\Domain\Inbox\Support\ReplyAddress;
use App\Domain\Media\Models\Media;
use App\Domain\Media\TenantStorage;
use App\Domain\Stores\Models\Store;
use App\Domain\Tenancy\Queue\TenantAware;
use Illuminate\Contracts\Queue\ShouldQueue;
use Illuminate\Foundation\Queue\Queueable;
use Illuminate\Support\Facades\Mail;
use Throwable;

/**
 * Mails one shop reply of an email conversation (PHASE-8-8E P88E-16, §11.1): 3 tries (backoff 1 / 5 / 15 min);
 * `delivery_status` queued → sent, or failed after the last try ("Not delivered"). Only `reply` rows (never notes).
 */
class SendInboxEmailReply implements ShouldQueue
{
    use Queueable, TenantAware;

    public int $tries = 3;

    /** @var list<int> */
    public array $backoff = [60, 300, 900];

    public function __construct(public readonly string $messageId)
    {
        $this->onQueue('notifications');
    }

    public function handle(TenantStorage $storage, InboxVersion $version): void
    {
        $message = InboxMessage::query()->whereKey($this->messageId)->where('kind', InboxMessage::REPLY)->first();
        if ($message === null || $message->delivery_status !== 'queued') {
            return;
        }
        $conversation = InboxConversation::query()->find($message->conversation_id);
        $store = $conversation !== null ? Store::query()->find($conversation->store_id) : null;
        $replyTo = $conversation !== null ? ReplyAddress::conversation($conversation->id) : null;
        if ($conversation === null || $store === null || $conversation->contact_email === null || $replyTo === null) {
            $message->forceFill(['delivery_status' => 'failed'])->save();
            $version->bump($message->store_id);

            return;
        }
        $files = [];
        foreach (InboxAttachment::query()->where('message_id', $message->id)->orderBy('id')->get() as $file) {
            $media = Media::query()->whereKey($file->media_id)->first();
            if ($media !== null && $media->status === Media::READY && $storage->ownsPath($media->path)) {
                $files[] = ['data' => (string) $storage->disk($media->disk)->get($media->path), 'name' => $file->filename, 'mime' => $file->mime];
            }
        }
        $subject = InboxText::line($conversation->subject ?? ('Your message to '.$store->name), 190);
        $subject = preg_match('/^re:/i', $subject) === 1 ? $subject : 'Re: '.$subject;

        Mail::to($conversation->contact_email)->send(new InboxReplyMail(
            $store->name, $replyTo, $subject, (string) $message->body, $conversation->last_inbound_message_id, $files,
        ));
        $message->forceFill(['delivery_status' => 'sent'])->save();
        $version->bump($message->store_id);
    }

    public function failed(?Throwable $e): void
    {
        $message = InboxMessage::query()->find($this->messageId);
        if ($message !== null && $message->delivery_status === 'queued') {
            $message->forceFill(['delivery_status' => 'failed'])->save();
            app(InboxVersion::class)->bump($message->store_id);
        }
    }
}
