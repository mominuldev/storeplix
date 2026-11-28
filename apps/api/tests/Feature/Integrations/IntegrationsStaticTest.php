<?php

declare(strict_types=1);

namespace Tests\Feature\Integrations;

use App\Domain\Integrations\Console\RotateIntegrationKey;
use App\Domain\Integrations\IntegrationProvider;
use App\Domain\Integrations\IntegrationsServiceProvider;
use App\Domain\Integrations\Models\StoreIntegration;
use App\Domain\Integrations\Settings\ProviderSettings;
use App\Domain\Tracking\Models\TrackingEvent;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/**
 * PHASE-8-9D static guards: S331 (no setting is markup / script; GTM has no web-container field), S332 (secrets hidden
 * on the models, never logged, never in job constructors; key rotation covers store_integrations), P89D fakes refused
 * in production.
 */
#[Group('integrations')]
#[Group('security')]
class IntegrationsStaticTest extends TestCase
{
    public function test_no_setting_holds_markup_and_gtm_has_no_web_container_field(): void
    {
        foreach (IntegrationProvider::ALL as $provider) {
            $keys = array_keys(ProviderSettings::for($provider)::defaults());
            foreach ($keys as $key) {
                $this->assertDoesNotMatchRegularExpression('/html|script|snippet|code_block|custom_code|head|tag_manager_web|web_container/i', $key, "{$provider}.{$key}");
            }
        }
        $this->assertNotContains('web_container_id', array_keys(ProviderSettings::for('gtm_server')::defaults()));
        $this->assertSame(['container_id', 'measurement_id'], array_keys(ProviderSettings::for('gtm_server')::idFields()));
    }

    public function test_secrets_are_hidden_on_models_and_never_logged_or_queued(): void
    {
        $this->assertContains('credentials', (new StoreIntegration)->getHidden());
        $this->assertContains('payload', (new TrackingEvent)->getHidden());
        $this->assertContains('credentials', RotateIntegrationKey::COLUMNS['store_integrations']);

        $problems = [];
        foreach (['Integrations', 'Tracking', 'Feeds'] as $domain) {
            $it = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator(app_path("Domain/{$domain}"), \FilesystemIterator::SKIP_DOTS));
            foreach ($it as $file) {
                if ($file->getExtension() !== 'php') {
                    continue;
                }
                $code = (string) file_get_contents($file->getPathname());
                foreach (explode("\n", $code) as $n => $line) {
                    if (preg_match('/Log::|report\(|logger\(/', $line) === 1 && preg_match('/secrets\(\)|credentials|access_token|api_secret|refresh_token|payload/', $line) === 1) {
                        $problems[] = $file->getFilename().':'.($n + 1);
                    }
                }
                // Jobs carry ids only (never a payload or a secret).
                if (str_contains($file->getPathname(), '/Jobs/') && preg_match('/function __construct\(([^)]*)\)/s', $code, $m) === 1) {
                    $this->assertDoesNotMatchRegularExpression('/array|payload|token|secret|credential/i', $m[1], $file->getFilename());
                }
            }
        }
        $this->assertSame([], $problems);
    }

    public function test_fake_drivers_are_refused_in_production(): void
    {
        $this->app['env'] = 'production';
        try {
            foreach (['tracking.fake', 'feeds.fake'] as $key) {
                config(['tracking.fake' => false, 'feeds.fake' => false, $key => true]);
                try {
                    IntegrationsServiceProvider::assertSafeConfiguration($this->app);
                    $this->fail("{$key} accepted in production");
                } catch (\RuntimeException) {
                    $this->addToAssertionCount(1);
                }
            }
            config(['tracking.fake' => false, 'feeds.fake' => false]);
            IntegrationsServiceProvider::assertSafeConfiguration($this->app);
        } finally {
            $this->app['env'] = 'testing';
        }
    }
}
