<?php

namespace App\Domain\Geo\Http;

use App\Domain\Geo\BdGeo;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;

/** §3.1 GET /geo/bd — public, cacheable 24 h, ETag = dataset version. */
class GeoController
{
    public function __invoke(Request $request, BdGeo $geo): JsonResponse|Response
    {
        $etag = '"bd-'.$geo->version().'"';
        $headers = ['Cache-Control' => 'public, max-age=86400', 'ETag' => $etag];

        if (in_array($etag, array_map('trim', explode(',', (string) $request->header('If-None-Match'))), true)) {
            return new Response('', 304, $headers);
        }

        return new JsonResponse(['data' => $geo->all()], 200, $headers, JSON_UNESCAPED_UNICODE);
    }
}
