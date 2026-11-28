<?php

declare(strict_types=1);

namespace Tests\Unit;

use App\Domain\Ai\AiException;
use App\Domain\Ai\Writer\DescriptionOutput;
use PHPUnit\Framework\Attributes\Group;
use PHPUnit\Framework\TestCase;

/** PHASE-8-9D P89D-53 (S345): model output is built into escaped HTML, never trusted; caps enforced. */
#[Group('ai')]
#[Group('security')]
class AiDescriptionOutputTest extends TestCase
{
    public function test_markup_and_control_characters_are_stripped_and_html_is_built_escaped(): void
    {
        $out = DescriptionOutput::build([[
            'paragraphs' => ["<script>alert(1)</script>Soft <b>cotton</b>\u{0000}\u{202E}  & airy", '&lt;img src=x onerror=alert(1)&gt;Plain', '   ', 42],
            'highlights' => ['<a href="javascript:x">Breathable</a>', 'Fits "true" to size'],
            'seo_title' => str_repeat('T', 90),
            'meta_description' => '<i></i>',
        ]], 3);

        $this->assertCount(1, $out);
        $v = $out[0];
        $this->assertSame(['Soft cotton & airy', 'Plain'], $v['paragraphs']);
        $this->assertSame(['Breathable', 'Fits "true" to size'], $v['highlights']);
        $this->assertSame(70, mb_strlen((string) $v['seo_title']));
        $this->assertStringEndsWith('…', (string) $v['seo_title']);
        $this->assertNull($v['meta_description']);
        $this->assertSame('<p>Soft cotton &amp; airy</p><p>Plain</p><ul><li>Breathable</li><li>Fits &quot;true&quot; to size</li></ul>', $v['description_html']);
        $this->assertStringNotContainsString('script', $v['description_html']);
    }

    public function test_caps_counts_and_variant_limit(): void
    {
        $item = ['paragraphs' => array_fill(0, 12, str_repeat('p', 1200)), 'highlights' => array_fill(0, 15, str_repeat('h', 200))];
        $out = DescriptionOutput::build([$item, $item, $item, $item], 2);
        $this->assertCount(2, $out);
        $this->assertCount(DescriptionOutput::MAX_PARAGRAPHS, $out[0]['paragraphs']);
        $this->assertCount(DescriptionOutput::MAX_HIGHLIGHTS, $out[0]['highlights']);
        $this->assertSame(1000, mb_strlen($out[0]['paragraphs'][0]));
        $this->assertSame(160, mb_strlen($out[0]['highlights'][0]));
    }

    public function test_no_usable_variant_is_output_invalid(): void
    {
        foreach ([[], [['paragraphs' => []]], ['nope'], [['paragraphs' => ['<b></b>']]]] as $raw) {
            try {
                DescriptionOutput::build($raw, 2);
                $this->fail('expected ai_output_invalid');
            } catch (AiException $e) {
                $this->assertSame(AiException::OUTPUT_INVALID, $e->errorCode);
            }
        }
    }
}
