<?php

namespace Tests\Unit;

use App\Domain\Stores\Services\HostNormalizer;
use PHPUnit\Framework\Attributes\DataProvider;
use PHPUnit\Framework\TestCase;

class HostNormalizerTest extends TestCase
{
    public static function hosts(): array
    {
        return [
            ['Demo.StorePlix.test', 'demo.storeplix.test'],
            ['demo.storeplix.test.', 'demo.storeplix.test'],
            ['demo.localhost:3010', 'demo.localhost'],
            ['  shop.example.com  ', 'shop.example.com'],
            ['', null],
            ['bad host', null],
            ['evil.com/path', null],
            ['-bad.example.com', null],
            ['a:b:c', null],
            ['demo.localhost:abc', null],
            [null, null],
        ];
    }

    #[DataProvider('hosts')]
    public function test_normalize(?string $input, ?string $expected): void
    {
        $this->assertSame($expected, HostNormalizer::normalize($input));
    }
}
