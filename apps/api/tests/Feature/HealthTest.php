<?php

namespace Tests\Feature;

use Tests\TestCase;

class HealthTest extends TestCase
{
    public function test_health_returns_ok_envelope(): void
    {
        $this->getJson('/api/v1/health')
            ->assertOk()
            ->assertExactJsonStructure(['data' => ['status', 'version', 'time']])
            ->assertJsonPath('data.status', 'ok')
            ->assertJsonPath('data.version', config('storeplix.version'));
    }

    public function test_unknown_api_route_uses_error_envelope(): void
    {
        $this->getJson('/api/v1/does-not-exist')
            ->assertNotFound()
            ->assertJsonPath('error.code', 'not_found');
    }
}
