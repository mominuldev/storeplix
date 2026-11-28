<?php

declare(strict_types=1);

namespace App\Domain\Ai\Writer;

use Anthropic\Client;
use Anthropic\Core\Exceptions\APIConnectionException;
use Anthropic\Core\Exceptions\APIException;
use Anthropic\Core\Exceptions\APIStatusException;
use Anthropic\Core\Exceptions\APITimeoutException;
use App\Domain\Ai\AiException;
use GuzzleHttp\Client as GuzzleClient;
use Illuminate\Support\Facades\Log;
use Psr\Http\Client\ClientInterface;
use Throwable;

/**
 * P89D-36/37: Anthropic Claude through the official PHP SDK (`anthropic-ai/sdk`, Messages API only).
 *
 * Request: model from config (`AI_TEXT_MODEL`, default `claude-opus-5-5`), `output_config.effort` from config, structured
 * output (`output_config.format` JSON schema), `max_tokens` 4,096, the fixed system prompt
 * (resources/ai/product-description.md), the product data as a delimited JSON block, the main image when sent; NO
 * temperature / top_p, NO `thinking` parameter (Opus 5.5 always thinks; disabled or budgets are rejected), no assistant
 * prefill, no tools; server-side refusal fallback on (`betas: [server-side-fallback-2026-07-01]`, `fallbacks: default`).
 * `stop_reason = refusal` → ai_refused; `max_tokens` or unparseable JSON → ai_output_invalid. Transport: Guzzle, fixed
 * host (config `ai.text.base_url`), 10 s connect / 60 s total, no redirects; the SDK retries twice (429, 5xx, network).
 * Logs carry codes and HTTP statuses only — never the key, the prompt or the model's text.
 */
final class AnthropicDescriptionWriter implements ProductDescriptionWriter
{
    /** Container key a test binds to a PSR-18 client (Guzzle MockHandler) to mock the SDK's HTTP. */
    public const TRANSPORTER = 'ai.anthropic.transporter';

    public function provider(): string
    {
        return 'anthropic';
    }

    /** @return array<string, mixed> the structured-output JSON schema */
    public static function schema(): array
    {
        $strings = ['type' => 'array', 'items' => ['type' => 'string']];

        return [
            'type' => 'object',
            'properties' => [
                'variants' => [
                    'type' => 'array',
                    'items' => [
                        'type' => 'object',
                        'properties' => [
                            'paragraphs' => $strings,
                            'highlights' => $strings,
                            'seo_title' => ['type' => 'string'],
                            'meta_description' => ['type' => 'string'],
                        ],
                        'required' => ['paragraphs', 'highlights', 'seo_title', 'meta_description'],
                        'additionalProperties' => false,
                    ],
                ],
            ],
            'required' => ['variants'],
            'additionalProperties' => false,
        ];
    }

    public static function systemPrompt(): string
    {
        return trim((string) file_get_contents(resource_path('ai/product-description.md')));
    }

    /** @return list<array<string, mixed>> the user message content blocks */
    public static function content(DescriptionRequest $request): array
    {
        $data = json_encode($request->productData(), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_HEX_TAG | JSON_HEX_AMP);
        $text = "<product_data>\n{$data}\n</product_data>\n\n"
            ."Language: {$request->language}\nTone: {$request->tone}\nLength: {$request->length}\n"
            ."Number of variants: {$request->variants}\n"
            .($request->image !== null ? "The attached image is the product's main photo.\n" : '');
        $content = [];
        if ($request->image !== null) {
            $content[] = ['type' => 'image', 'source' => ['type' => 'base64', 'mediaType' => $request->image['media_type'], 'data' => $request->image['data']]];
        }
        $content[] = ['type' => 'text', 'text' => $text];

        return $content;
    }

    public function write(DescriptionRequest $request): WriterResult
    {
        $config = (array) config('ai.text');
        $model = (string) ($config['model'] ?? 'claude-opus-5-5');
        try {
            $message = $this->client()->beta->messages->create(
                maxTokens: (int) ($config['max_tokens'] ?? 4096),
                messages: [['role' => 'user', 'content' => self::content($request)]],
                model: $model,
                fallbacks: 'default',
                outputConfig: [
                    'effort' => (string) ($config['effort'] ?? 'medium'),
                    'format' => ['type' => 'json_schema', 'schema' => self::schema()],
                ],
                system: self::systemPrompt(),
                betas: [(string) ($config['fallback_beta'] ?? 'server-side-fallback-2026-07-01')],
            );
        } catch (APITimeoutException) {
            throw $this->fail(AiException::TIMEOUT, null);
        } catch (APIConnectionException) {
            throw $this->fail(AiException::UNAVAILABLE, null);
        } catch (APIStatusException $e) {
            $status = (int) $e->status;
            throw $this->fail($status === 429 || $status >= 500 ? AiException::UNAVAILABLE : AiException::PROVIDER_ERROR, $status);
        } catch (APIException) {
            throw $this->fail(AiException::PROVIDER_ERROR, null);
        }

        $usage = ['input_tokens' => (int) $message->usage->inputTokens, 'output_tokens' => (int) $message->usage->outputTokens];
        Log::info('ai.anthropic', ['action' => 'messages', 'model' => $message->model, 'stop_reason' => $message->stopReason] + $usage);
        if ($message->stopReason === 'refusal') {
            throw new AiException(AiException::REFUSED, 'The model declined this request.');
        }
        if ($message->stopReason === 'max_tokens') {
            throw new AiException(AiException::OUTPUT_INVALID, 'The model ran out of tokens.');
        }
        $text = '';
        foreach ($message->content as $block) {
            if (($block->type ?? null) === 'text') {
                $text .= (string) $block->text;
            }
        }
        try {
            $decoded = json_decode($text, true, 32, JSON_THROW_ON_ERROR);
        } catch (Throwable) {
            throw new AiException(AiException::OUTPUT_INVALID, 'The model returned invalid JSON.');
        }
        if (! is_array($decoded) || ! is_array($decoded['variants'] ?? null) || ! array_is_list($decoded['variants'])) {
            throw new AiException(AiException::OUTPUT_INVALID, 'The model output does not match the schema.');
        }

        return new WriterResult($decoded['variants'], $message->model, $usage);
    }

    private function client(): Client
    {
        $config = (array) config('ai.text');
        $key = (string) ($config['api_key'] ?? '');
        if ($key === '') {
            throw new AiException(AiException::UNAVAILABLE, 'ANTHROPIC_API_KEY is not configured.');
        }
        $transporter = app()->bound(self::TRANSPORTER) ? app(self::TRANSPORTER) : new GuzzleClient([
            'connect_timeout' => 10,
            'timeout' => (int) ($config['timeout'] ?? 60),
            'allow_redirects' => false,
            'http_errors' => false,
        ]);
        assert($transporter instanceof ClientInterface);

        return new Client(
            apiKey: $key,
            baseUrl: (string) ($config['base_url'] ?? 'https://api.anthropic.com'),
            requestOptions: [
                'timeout' => (float) ($config['timeout'] ?? 60),
                'maxRetries' => (int) ($config['max_retries'] ?? 2),
                'transporter' => $transporter,
            ],
            openTelemetry: false,
        );
    }

    private function fail(string $code, ?int $status): AiException
    {
        Log::warning('ai.anthropic_failed', ['code' => $code, 'status' => $status]);

        return new AiException($code, "Anthropic request failed ({$code}".($status !== null ? ", HTTP {$status}" : '').').');
    }
}
