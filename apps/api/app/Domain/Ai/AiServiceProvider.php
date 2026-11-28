<?php

declare(strict_types=1);

namespace App\Domain\Ai;

use App\Domain\Ai\Console\PruneAi;
use App\Domain\Ai\Photos\FakePhotoEditor;
use App\Domain\Ai\Photos\PhotoEditor;
use Illuminate\Cache\RateLimiting\Limit;
use Illuminate\Contracts\Foundation\Application;
use Illuminate\Http\Request;
use Illuminate\Support\Facades\RateLimiter;
use Illuminate\Support\ServiceProvider;
use RuntimeException;

/**
 * Phase 8.9d part B AI tools: the photo driver binding (fake until Q358 is decided), the `ai-generate` limiter
 * (P89D-59: 20/min and 300/day per member), `ai:prune`, and the boot check that refuses AI_DRIVER=fake in production.
 * Registered from AppServiceProvider.
 */
final class AiServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->bind(PhotoEditor::class, FakePhotoEditor::class);
    }

    public function boot(): void
    {
        self::assertSafeConfiguration($this->app);
        if ($this->app->runningInConsole()) {
            $this->commands([PruneAi::class]);
        }
        RateLimiter::for('ai-generate', function (Request $r) {
            $member = 'ai-generate:'.strtolower((string) $r->user()?->getAuthIdentifier());
            $limits = (array) config('ai.limits');

            return [
                Limit::perMinute((int) ($limits['per_minute'] ?? 20))->by($member.':m'),
                Limit::perDay((int) ($limits['per_day'] ?? 300))->by($member.':d'),
            ];
        });
    }

    /** P89D-36: the fake text driver never runs in production (the fake image driver only shows "Coming soon" there). */
    public static function assertSafeConfiguration(Application $app): void
    {
        if ($app->environment('production') && config('ai.driver') === 'fake') {
            throw new RuntimeException('AI_DRIVER=fake is not allowed in production.');
        }
    }
}
