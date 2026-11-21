<?php

namespace App\Domain\Shared\Http;

use App\Domain\Tenancy\Exceptions\MissingTenantContextException;
use Illuminate\Auth\AuthenticationException;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Validation\ValidationException;
use Symfony\Component\HttpKernel\Exception\HttpExceptionInterface;
use Throwable;

/**
 * Renders every exception on /api/* into the consistent error envelope.
 */
class ApiExceptionRenderer
{
    private const CODES = [
        400 => 'bad_request',
        401 => 'unauthenticated',
        403 => 'forbidden',
        404 => 'not_found',
        405 => 'method_not_allowed',
        409 => 'conflict',
        419 => 'token_mismatch',
        422 => 'unprocessable',
        429 => 'too_many_requests',
        503 => 'service_unavailable',
    ];

    public function __invoke(Throwable $e, Request $request): ?JsonResponse
    {
        if (! $request->is('api/*')) {
            return null;
        }

        return match (true) {
            $e instanceof ValidationException => $this->error(422, 'validation_failed', 'The given data was invalid.', $e->errors()),
            $e instanceof AuthenticationException => $this->error(401, 'unauthenticated', 'Unauthenticated.'),
            $e instanceof ApiException => $this->error($e->getStatusCode(), $e->errorCode, $e->getMessage(), $e->details, $e->getHeaders()),
            $e instanceof HttpExceptionInterface => $this->fromHttp($e),
            $e instanceof MissingTenantContextException => $this->error(500, 'tenant_context_missing', config('app.debug') ? $e->getMessage() : 'Server error.'),
            default => $this->error(500, 'server_error', config('app.debug') ? $e->getMessage() : 'Server error.'),
        };
    }

    private function fromHttp(HttpExceptionInterface $e): JsonResponse
    {
        $status = $e->getStatusCode();
        $message = $e->getMessage();

        // Never leak model class names from ModelNotFoundException ("No query results for model ...").
        if ($status === 404 || $message === '') {
            $message = match ($status) {
                403 => $message !== '' ? $message : 'This action is unauthorized.',
                404 => 'Resource not found.',
                default => 'HTTP error.',
            };
        }

        return $this->error($status, self::CODES[$status] ?? 'http_error', $message, null, $e->getHeaders());
    }

    /**
     * @param  array<string, array<int, string>>|null  $details
     * @param  array<string, string>  $headers
     */
    private function error(int $status, string $code, string $message, ?array $details = null, array $headers = []): JsonResponse
    {
        $body = ['code' => $code, 'message' => $message];

        if ($details !== null) {
            $body['details'] = $details;
        }

        return new JsonResponse(['error' => $body], $status, $headers);
    }
}
