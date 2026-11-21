<?php

namespace Tests\Feature\Themes;

use App\Domain\Themes\ThemeConfigUpgrader;
use App\Domain\Themes\ThemeConfigValidator;
use Tests\TestCase;

class ThemeConfigUpgraderTest extends TestCase
{
    private const PHASE2_DEFAULT = [
        'theme' => 'modern-commerce',
        'version' => '1.0.0',
        'settings' => ['primaryColor' => '#5B53FF', 'secondaryColor' => '#0d0d18', 'fontFamily' => 'Inter'],
        'sections' => [['type' => 'hero', 'enabled' => true], ['type' => 'featured-products', 'enabled' => true]],
    ];

    private function upgrade(array $old): array
    {
        $config = app(ThemeConfigUpgrader::class)->toV1_1($old);
        app(ThemeConfigValidator::class)->validate('modern-commerce', $config, checkMedia: false); // throws if invalid

        return $config;
    }

    public function test_phase2_default_config_gets_colours_kept_and_the_default_home(): void
    {
        $config = $this->upgrade(self::PHASE2_DEFAULT);

        $this->assertSame('1.1.0', $config['version']);
        $this->assertSame('#5b53ff', $config['settings']['primaryColor']);
        $this->assertSame('#0d0d18', $config['settings']['secondaryColor']);
        $this->assertSame('Inter', $config['settings']['fontFamily']);
        $this->assertSame('Fraunces', $config['settings']['headingFontFamily']); // filled from defaults
        $this->assertCount(10, $config['sections']); // untouched Phase 2 list → 1.1 default home
        $ids = array_column($config['sections'], 'id');
        $this->assertSame($ids, array_unique($ids));
    }

    public function test_demo_config_with_settings_keeps_sections_and_maps_old_fields(): void
    {
        $config = $this->upgrade([
            'theme' => 'modern-commerce',
            'version' => '1.0.0',
            'settings' => [
                'primaryColor' => '#112233', 'fontFamily' => 'Comic Sans', 'announcement' => 'Eid sale',
                'promoLink' => ['label' => 'Eid', 'href' => '/collections/eid'], 'footerTagline' => 'Hello',
                'paymentMethods' => ['Cash on delivery', 'bKash', 'PayPal'], 'navigation' => [['label' => 'x', 'href' => '/x']],
            ],
            'sections' => [
                ['type' => 'hero', 'enabled' => true, 'settings' => [
                    'heading' => 'Hi', 'image' => 'https://evil.example/x.png', 'primaryCtaHref' => 'javascript:alert(1)',
                    'layout' => 'weird', 'stats' => [['value' => '4.9', 'label' => 'Great']],
                ]],
                ['type' => 'carousel', 'enabled' => true],
                ['type' => 'featured-products', 'enabled' => false, 'settings' => ['title' => 'New', 'limit' => 4]],
            ],
        ]);

        $this->assertSame('#112233', $config['settings']['primaryColor']);
        $this->assertSame('Instrument Sans', $config['settings']['fontFamily']); // not allowlisted → default
        $this->assertSame('Eid sale', $config['settings']['announcement']['text']);
        $this->assertSame(['label' => 'Eid', 'href' => '/collections/eid'], $config['settings']['header']['promoLink']);
        $this->assertSame('Hello', $config['settings']['footer']['tagline']);
        $this->assertSame(['cod', 'bkash'], $config['settings']['footer']['paymentMethods']);
        $this->assertArrayNotHasKey('navigation', $config['settings']);

        $this->assertSame(['hero', 'featured-products'], array_column($config['sections'], 'type'));
        $hero = $config['sections'][0];
        $this->assertSame('Hi', $hero['settings']['heading']);
        $this->assertArrayNotHasKey('image', $hero['settings']);
        $this->assertNotSame('javascript:alert(1)', $hero['settings']['primaryCtaHref'] ?? null);
        $this->assertSame([['value' => '4.9', 'label' => 'Great']], array_column($hero['blocks'], 'settings'));
        $this->assertFalse($config['sections'][1]['enabled']);
        $this->assertSame('New', $config['sections'][1]['settings']['title']);
    }

    public function test_garbage_input_still_yields_a_valid_config(): void
    {
        foreach ([[], ['sections' => 'nope', 'settings' => 5], ['sections' => [['type' => 'hero', 'settings' => ['heading' => str_repeat('x', 500)]], 'str', null]]] as $garbage) {
            $config = $this->upgrade($garbage);
            $this->assertSame('modern-commerce', $config['theme']);
            $this->assertNotEmpty($config['sections']);
        }
    }
}
