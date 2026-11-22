<?php

declare(strict_types=1);

namespace App\Domain\Couriers\Drivers;

/** A courier-side pickup store (Pathao stores, RedX pickup stores): `{ id, name, address }`. */
final readonly class PickupStore
{
    public function __construct(
        public string $id,
        public string $name,
        public ?string $address = null,
    ) {}

    /** @return array{id: string, name: string, address: ?string} */
    public function toArray(): array
    {
        return ['id' => $this->id, 'name' => $this->name, 'address' => $this->address];
    }
}
