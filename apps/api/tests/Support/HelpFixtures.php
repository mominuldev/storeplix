<?php

declare(strict_types=1);

namespace Tests\Support;

use App\Domain\Admin\Authorization\PlatformRole;
use App\Domain\Help\HelpArticleService;
use App\Domain\Help\HelpCategoryService;
use App\Domain\Help\Models\HelpArticle;
use App\Domain\Help\Models\HelpCategory;
use App\Domain\Identity\Models\User;
use App\Domain\Support\Models\SupportTicket;
use App\Domain\Support\SupportTicketService;
use App\Domain\Tenancy\Authorization\SystemRole;
use App\Domain\Tenancy\Models\Tenant;
use Illuminate\Http\UploadedFile;
use Illuminate\Support\Str;
use Illuminate\Testing\TestResponse;

/**
 * Phase 8.9c fixtures: help categories / articles written through the real services (platform connection), and
 * tickets created inside a tenant. Needs PlatformStaffFixtures (staffUser) and TestCase::inTenant.
 */
trait HelpFixtures
{
    private ?User $helpAuthor = null;

    protected function helpAuthor(): User
    {
        return $this->helpAuthor ??= $this->staffUser(PlatformRole::Support);
    }

    protected function helpCategory(string $slug = 'getting-started', string $name = 'Getting started', ?string $nameBn = null): HelpCategory
    {
        return app(HelpCategoryService::class)->create($this->helpAuthor(), [
            'slug' => $slug, 'name_en' => $name, 'name_bn' => $nameBn, 'icon' => 'rocket', 'description_en' => 'Start here',
        ]);
    }

    /** @return array<string, mixed> */
    protected static function helpDoc(string $text = 'Open Settings and choose Payments.', array $extra = []): array
    {
        return ['type' => 'doc', 'content' => [
            ['type' => 'heading', 'attrs' => ['level' => 2], 'content' => [['type' => 'text', 'text' => 'First steps']]],
            ['type' => 'paragraph', 'content' => [['type' => 'text', 'text' => $text]]],
            ...$extra,
        ]];
    }

    /** @return array<string, mixed> */
    protected static function helpTranslation(string $title, string $summary = 'A short summary.', ?array $body = null, array $keywords = []): array
    {
        return ['title' => $title, 'summary' => $summary, 'body' => $body ?? self::helpDoc(), 'keywords' => $keywords];
    }

    /**
     * A draft article with complete translations (en always, bn when given).
     *
     * @param  array<string, mixed>|null  $bn
     */
    protected function helpDraft(HelpCategory $category, string $slug, string $title, ?array $bn = null, ?array $en = null): HelpArticle
    {
        $service = app(HelpArticleService::class);
        $article = $service->create($this->helpAuthor(), $slug, $category->id, $title);
        $translations = ['en' => $en ?? self::helpTranslation($title)];
        if ($bn !== null) {
            $translations['bn'] = $bn;
        }

        return $service->update($article->id, $this->helpAuthor(), ['revision' => $article->revision, 'translations' => $translations]);
    }

    /** @param array<string, mixed>|null $bn */
    protected function helpPublished(HelpCategory $category, string $slug, string $title, ?array $bn = null, ?array $en = null): HelpArticle
    {
        $draft = $this->helpDraft($category, $slug, $title, $bn, $en);

        return app(HelpArticleService::class)->publish($draft->id, $this->helpAuthor(), $draft->revision, null);
    }

    protected static function pdfBytes(): string
    {
        return "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n";
    }

    /** @param array<string, string> $h */
    protected function supportUpload(array $h, string $name = 'proof.pdf', ?string $bytes = null, string $url = '/api/v1/help/attachments'): TestResponse
    {
        return $this->flushHeaders()->withHeaders($h)->post($url, [
            'file' => UploadedFile::fake()->createWithContent($name, $bytes ?? self::pdfBytes()),
        ], ['Accept' => 'application/json']);
    }

    /** @param array<string, mixed> $extra */
    protected static function ticketBody(array $extra = []): array
    {
        return $extra + ['category' => 'orders_payments', 'subject' => 'Payment not showing', 'description' => 'A bKash payment is not showing on my order.',
            'priority' => 'normal', 'client_id' => (string) Str::uuid()];
    }

    /** Cross-tenant ids → 404 `not_found` (S248). @param list<array{0: string, 1: string, 2?: array<string, mixed>}> $requests */
    protected function assertTenantIsolation(array $headersA, array $requests): void
    {
        foreach ($requests as $request) {
            $this->flushHeaders()->withHeaders($headersA)->json($request[0], $request[1], $request[2] ?? [])
                ->assertNotFound()->assertJsonPath('error.code', 'not_found');
        }
    }

    /** @param array<string, mixed> $overrides */
    protected function helpTicket(Tenant $tenant, User $requester, array $overrides = []): SupportTicket
    {
        return $this->tenancy()->run($tenant, fn () => app(SupportTicketService::class)->create($requester, $overrides + [
            'category' => 'orders_payments', 'subject' => 'Payment not showing', 'description' => 'A bKash payment is not showing on my order.',
            'priority' => 'normal', 'client_id' => (string) Str::uuid(),
        ])[0], 'owner', SystemRole::Owner->permissions());
    }
}
