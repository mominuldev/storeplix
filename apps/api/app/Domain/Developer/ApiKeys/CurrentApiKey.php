<?php

declare(strict_types=1);

namespace App\Domain\Developer\ApiKeys;

use App\Domain\Developer\ApiKeys\Models\ApiKey;
use Illuminate\Container\Attributes\Scoped;

/**
 * PHASE-8-4 §3: the API key acting in the current external API request (set and cleared by the `apikey` middleware).
 * Actor plumbing reads it: audit rows (`actor_type = api_key`), order events and stock movements
 * (`actor_api_key_id`). Null everywhere else (merchant, storefront, jobs).
 */
#[Scoped]
final class CurrentApiKey
{
    private ?ApiKey $key = null;

    public function set(ApiKey $key): void
    {
        $this->key = $key;
    }

    public function clear(): void
    {
        $this->key = null;
    }

    public function get(): ?ApiKey
    {
        return $this->key;
    }

    public function id(): ?string
    {
        return $this->key?->id;
    }

    /** Display name of the actor ("API: <key name>"). */
    public function actorName(): ?string
    {
        return $this->key === null ? null : 'API: '.$this->key->name;
    }

    /** Shortcut for code outside the external API (null when no key acts). */
    public static function current(): ?ApiKey
    {
        return app(self::class)->get();
    }
}
