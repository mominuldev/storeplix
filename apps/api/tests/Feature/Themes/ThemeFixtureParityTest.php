<?php

namespace Tests\Feature\Themes;

use App\Domain\Shared\Http\ApiException;
use App\Domain\Themes\ThemeConfigValidator;
use App\Domain\Themes\ThemeLimits;
use App\Domain\Themes\ThemeRegistry;
use Illuminate\Validation\ValidationException;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\Attributes\Group;
use Tests\TestCase;

/** Shared fixtures (packages/themes/fixtures) through ThemeConfigValidator (PHASE-3-CONTRACT §9). */
#[Group('security')]
class ThemeFixtureParityTest extends TestCase
{
    private static function dir(): string
    {
        return dirname(__DIR__, 3).'/resources/themes/fixtures/modern-commerce';
    }

    /** @return array<string, array{0: string}> */
    public static function valid(): array
    {
        return self::files('valid');
    }

    /** @return array<string, array{0: string}> */
    public static function invalid(): array
    {
        return self::files('invalid');
    }

    /** @return array<string, array{0: string}> */
    private static function files(string $kind): array
    {
        $out = [];
        foreach (glob(self::dir()."/{$kind}/*.json") ?: [] as $file) {
            $out[basename($file)] = [$file];
        }

        return $out;
    }

    public function test_fixture_sets_meet_the_contract_minimums(): void
    {
        $this->assertGreaterThanOrEqual(6, count(self::valid()));
        $this->assertGreaterThanOrEqual(20, count(self::invalid()));
    }

    #[DataProvider('valid')]
    public function test_valid_fixture_validates(string $file): void
    {
        $config = json_decode((string) file_get_contents($file), false);
        $validator = app(ThemeConfigValidator::class);

        $this->assertSame([], $validator->schemaErrorsFor('modern-commerce', json_decode(json_encode($config), true)), 'schema');

        $normalised = $validator->validate('modern-commerce', $config, checkMedia: false);
        $this->assertSame('modern-commerce', $normalised['theme']);
    }

    #[DataProvider('invalid')]
    public function test_invalid_fixture_fails_with_expected_path(string $file): void
    {
        $fixture = json_decode((string) file_get_contents($file), false);
        $expect = 'config.'.$fixture->expect;

        try {
            app(ThemeConfigValidator::class)->validate('modern-commerce', $fixture->config, checkMedia: false);
            $this->fail(basename($file).' was accepted.');
        } catch (ValidationException $e) {
            $keys = array_keys($e->errors());
            $hit = array_filter($keys, fn ($k) => $k === $expect || str_starts_with($k, $expect.'.'));
            $this->assertNotEmpty($hit, basename($file)." expected an error at {$expect}, got: ".implode(', ', $keys));
            $this->assertLessThanOrEqual(50, count($keys));
        } catch (ApiException $e) {
            // Wrong theme or major version is rejected before the schema stage (§3.1 theme_mismatch).
            $this->assertSame('theme_mismatch', $e->errorCode);
            $this->assertContains($fixture->expect, ['theme', 'version']);
        }
    }

    public function test_defaults_are_valid_and_registry_matches_contract(): void
    {
        $registry = app(ThemeRegistry::class);
        app(ThemeConfigValidator::class)->validate('modern-commerce', $registry->defaults('modern-commerce'), checkMedia: false);

        $this->assertSame('Gallery', $registry->name('modern-commerce'));
        $this->assertSame(1, $registry->major('modern-commerce'));
        $this->assertCount(9, $registry->catalog());
        $this->assertSame(['modern-commerce'], array_column(array_filter($registry->catalog(), fn ($t) => $t['status'] === 'available'), 'code'));
        $this->assertSame(ThemeRegistry::FONTS, $registry->fonts());
        $this->assertSame(ThemeLimits::MAX_INSTANCES, $registry->maxInstances('modern-commerce'));
    }
}
