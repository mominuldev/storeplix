<?php

declare(strict_types=1);

namespace App\Domain\Ai\Writer;

use App\Domain\Ai\AiException;

/**
 * AI_DRIVER=fake (local, testing, e2e; refused in production by the boot check). Deterministic copy built from the
 * request. Test triggers in the product name: `[refuse]` → ai_refused, `[unavailable]` → ai_unavailable, `[timeout]` →
 * ai_timeout, `[invalid]` → output with no paragraphs (ai_output_invalid after building).
 */
final class FakeDescriptionWriter implements ProductDescriptionWriter
{
    /** @var list<DescriptionRequest> requests seen (tests) */
    public static array $requests = [];

    public function provider(): string
    {
        return 'fake';
    }

    public function write(DescriptionRequest $request): WriterResult
    {
        self::$requests[] = $request;
        foreach (['[refuse]' => AiException::REFUSED, '[unavailable]' => AiException::UNAVAILABLE, '[timeout]' => AiException::TIMEOUT] as $marker => $code) {
            if (str_contains($request->name, $marker)) {
                throw new AiException($code, 'Fake writer: '.$code);
            }
        }
        if (str_contains($request->name, '[invalid]')) {
            return new WriterResult([['paragraphs' => [], 'highlights' => []]], 'fake-writer');
        }
        $bn = $request->language === 'bn';
        $variants = [];
        for ($i = 1; $i <= $request->variants; $i++) {
            $variants[] = [
                'paragraphs' => [
                    ($bn ? "{$request->name} — আপনার প্রতিদিনের সঙ্গী।" : "Meet the {$request->name}, made for every day.")." ({$request->tone}, {$request->length}, #{$i})",
                    $bn ? 'যত্ন করে তৈরি, দীর্ঘদিন টেকে।' : 'Carefully made to last.',
                ],
                'highlights' => array_slice(array_merge($request->keyPoints, [$bn ? 'আরামদায়ক' : 'Comfortable']), 0, 5),
                'seo_title' => $request->name,
                'meta_description' => ($bn ? 'কিনুন ' : 'Buy ').$request->name,
            ];
        }

        return new WriterResult($variants, 'fake-writer', ['input_tokens' => 0, 'output_tokens' => 0]);
    }
}
