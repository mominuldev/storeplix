<?php

namespace Tests\Feature\Themes;

use Tests\TestCase;

/**
 * resources/themes/ must stay a byte-identical copy of packages/themes (PHASE-3-CONTRACT §4.1).
 * Runs whenever the monorepo checkout is present (local + CI).
 */
class ThemeSchemaSyncTest extends TestCase
{
    /** Files and directories mirrored from packages/themes. */
    private const MIRRORED = ['registry.json', 'fonts.json', 'modern-commerce', 'fixtures'];

    public function test_resources_themes_matches_packages_themes(): void
    {
        $source = base_path('../../packages/themes');
        if (! is_dir($source)) {
            $this->markTestSkipped('packages/themes is not available in this checkout.');
        }

        $expected = $this->hashes($source);
        $actual = $this->hashes(resource_path('themes'));

        $this->assertNotEmpty($expected);
        foreach ($expected as $file => $hash) {
            $this->assertArrayHasKey($file, $actual, "Missing copy of packages/themes/{$file} in resources/themes.");
            $this->assertSame($hash, $actual[$file], "resources/themes/{$file} drifted from packages/themes (re-copy it).");
        }
        $this->assertSame([], array_values(array_diff(array_keys($actual), array_keys($expected))), 'resources/themes has files that packages/themes does not.');
    }

    /** @return array<string, string> relative path => sha256 */
    private function hashes(string $root): array
    {
        $out = [];
        foreach (self::MIRRORED as $entry) {
            $path = "{$root}/{$entry}";
            if (is_file($path)) {
                $out[$entry] = hash_file('sha256', $path);
            } elseif (is_dir($path)) {
                $it = new \RecursiveIteratorIterator(new \RecursiveDirectoryIterator($path, \FilesystemIterator::SKIP_DOTS));
                foreach ($it as $file) {
                    $relative = $entry.'/'.substr($file->getPathname(), strlen($path) + 1);
                    $out[$relative] = hash_file('sha256', $file->getPathname());
                }
            }
        }
        ksort($out);

        return $out;
    }
}
