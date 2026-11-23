<?php

declare(strict_types=1);

namespace App\Domain\Tenancy\Authorization;

/**
 * Immutable set of permissions (P83-5). Always iterates in catalogue order. Unknown strings are dropped
 * (`fromKeys`), so a stray `role_permissions` row can never grant anything (S99).
 */
final class PermissionSet
{
    /** @var array<string, Permission> keyed by value */
    private readonly array $items;

    /** @param iterable<Permission> $permissions */
    public function __construct(iterable $permissions = [])
    {
        $items = [];
        foreach ($permissions as $permission) {
            $items[$permission->value] = $permission;
        }
        $ordered = [];
        foreach (Permission::cases() as $case) {
            if (isset($items[$case->value])) {
                $ordered[$case->value] = $case;
            }
        }
        $this->items = $ordered;
    }

    public static function all(): self
    {
        return new self(Permission::cases());
    }

    public static function none(): self
    {
        return new self;
    }

    /** @param iterable<string> $keys unknown keys are ignored */
    public static function fromKeys(iterable $keys): self
    {
        $out = [];
        foreach ($keys as $key) {
            if (is_string($key) && ($p = Permission::tryFrom($key)) !== null) {
                $out[] = $p;
            }
        }

        return new self($out);
    }

    public function has(Permission $permission): bool
    {
        return isset($this->items[$permission->value]);
    }

    public function hasAny(Permission ...$permissions): bool
    {
        foreach ($permissions as $permission) {
            if ($this->has($permission)) {
                return true;
            }
        }

        return false;
    }

    /** Every permission of $other is in this set. */
    public function contains(self $other): bool
    {
        return $other->missingFrom($this) === [];
    }

    /** @return list<Permission> keys of this set that $holder lacks (catalogue order) */
    public function missingFrom(self $holder): array
    {
        return array_values(array_filter($this->items, fn (Permission $p) => ! $holder->has($p)));
    }

    /** @return list<Permission> */
    public function toArray(): array
    {
        return array_values($this->items);
    }

    /** @return list<string> */
    public function keys(): array
    {
        return array_keys($this->items);
    }

    public function count(): int
    {
        return count($this->items);
    }

    public function equals(self $other): bool
    {
        return $this->keys() === $other->keys();
    }
}
