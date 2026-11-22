<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Drivers;

/** One courier area entry (types `CourierArea`). Levels: city, zone, area (RedX uses `area` only). */
final readonly class CourierArea
{
    public const LEVELS = ['city', 'zone', 'area'];

    public function __construct(
        public string $id,
        public string $name,
        public string $level,
        public ?string $parentId = null,
    ) {}

    /** @return array{id: string, name: string, level: string, parent_id: ?string} */
    public function toArray(): array
    {
        return ['id' => $this->id, 'name' => $this->name, 'level' => $this->level, 'parent_id' => $this->parentId];
    }

    /** @param array{id: string, name: string, level: string, parent_id: ?string} $a */
    public static function fromArray(array $a): self
    {
        return new self((string) $a['id'], (string) $a['name'], (string) $a['level'], $a['parent_id'] ?? null);
    }
}
