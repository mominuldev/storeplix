<?php

use Illuminate\Support\Facades\Route;

// API-only application: everything lives under /api/v1 (see routes/api.php).
Route::get('/', fn () => response()->json(['data' => ['name' => 'Store Plix API', 'docs' => '/api/v1/health']]));
