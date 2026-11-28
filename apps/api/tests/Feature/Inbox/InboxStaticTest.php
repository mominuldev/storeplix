<?php

declare(strict_types=1);

namespace Tests\Feature\Inbox;

use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * S236 static: every shopper / email / SMS path reads messages with the explicit shopper kinds (customer + reply), so
 * notes and system rows can never leave; and the SMS jobs go through SmsCharger (S239).
 */
#[Group('inbox')]
#[Group('security')]
class InboxStaticTest extends TestCase
{
    public function test_shopper_paths_select_only_customer_and_reply_rows(): void
    {
        $paths = [
            'app/Domain/Inbox/Http/Controllers/StorefrontInboxController.php' => 'InboxMessage::SHOPPER_KINDS',
            'app/Domain/Inbox/Http/Controllers/InboxAttachmentController.php' => 'InboxMessage::SHOPPER_KINDS',
            'app/Domain/Inbox/InboxPresenter.php' => 'InboxMessage::SHOPPER_KINDS',
            'app/Domain/Inbox/ConversationService.php' => 'InboxMessage::SHOPPER_KINDS', // assignment email preview
        ];
        foreach ($paths as $path => $needle) {
            $this->assertStringContainsString($needle, (string) file_get_contents(base_path($path)), $path);
        }
        // The email and SMS jobs only ever load `reply` rows.
        foreach (['SendInboxEmailReply', 'SendInboxReplySms'] as $job) {
            $this->assertStringContainsString("where('kind', InboxMessage::REPLY)", (string) file_get_contents(base_path("app/Domain/Inbox/Jobs/{$job}.php")), $job);
        }
        $this->assertStringContainsString('SmsCharger', (string) file_get_contents(base_path('app/Domain/Inbox/InboxSms.php')));
    }
}
