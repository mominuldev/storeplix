<?php

declare(strict_types=1);

namespace Tests\Unit\Marketing;

use App\Domain\Marketing\Content\SmsParts;
use PHPUnit\Framework\Attributes\Group;
use PHPUnit\Framework\TestCase;

/** PHASE-8-5 §5.3: SmsParts against the shared vectors (docs/api/sms-parts-vectors.json, also run by the dashboard). */
#[Group('campaigns')]
class SmsPartsTest extends TestCase
{
    public function test_every_shared_vector(): void
    {
        $file = dirname(__DIR__, 5).'/docs/api/sms-parts-vectors.json';
        $this->assertFileExists($file);
        $vectors = json_decode((string) file_get_contents($file), true)['vectors'];
        $this->assertGreaterThanOrEqual(20, count($vectors));
        foreach ($vectors as $v) {
            $this->assertSame(
                ['encoding' => $v['encoding'], 'parts' => $v['parts'], 'units' => $v['units']],
                SmsParts::count($v['text']),
                $v['name'],
            );
        }
    }

    public function test_boundaries_and_extension_characters(): void
    {
        $this->assertSame(['encoding' => 'gsm7', 'parts' => 0, 'units' => 0], SmsParts::count(''));
        $this->assertSame(1, SmsParts::partsOf(str_repeat('a', 160)));
        $this->assertSame(2, SmsParts::partsOf(str_repeat('a', 161)));
        $this->assertSame(3, SmsParts::partsOf(str_repeat('a', 307)));
        $this->assertSame(['encoding' => 'gsm7', 'parts' => 1, 'units' => 4], SmsParts::count('{}'));
        $this->assertSame(2, SmsParts::partsOf(str_repeat('a', 159).'€'));
        $this->assertSame(['encoding' => 'ucs2', 'parts' => 1, 'units' => 70], SmsParts::count(str_repeat('ক', 70)));
        $this->assertSame(['encoding' => 'ucs2', 'parts' => 2, 'units' => 71], SmsParts::count(str_repeat('ক', 71)));
        $this->assertSame(['encoding' => 'ucs2', 'parts' => 3, 'units' => 135], SmsParts::count(str_repeat('ক', 135)));
        $this->assertSame(['encoding' => 'ucs2', 'parts' => 1, 'units' => 2], SmsParts::count('😀'));
        $this->assertSame('ucs2', SmsParts::count("form\ffeed")['encoding']); // §9.1: form feed is not GSM here
    }
}
