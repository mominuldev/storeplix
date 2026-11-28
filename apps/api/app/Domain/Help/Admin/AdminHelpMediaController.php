<?php

declare(strict_types=1);

namespace App\Domain\Help\Admin;

use App\Domain\Admin\Tenants\AdminPresenter;
use App\Domain\Admin\Tenants\Http\AdminBillingController;
use App\Domain\Help\HelpMediaService;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\UploadedFile;
use Illuminate\Validation\ValidationException;

/** POST /admin/help-media (PHASE-8-9C P89C-6, S254): staff-only platform help image → 201 HelpMediaRef. */
class AdminHelpMediaController
{
    public function store(Request $request, HelpMediaService $media): JsonResponse
    {
        $input = $request->validate(['file' => ['required', 'file'], 'alt' => ['sometimes', 'nullable', 'string', 'max:200']]);
        /** @var UploadedFile $file */
        $file = $request->file('file');
        $info = $media->inspect($file);
        if (is_string($info)) {
            throw ValidationException::withMessages(['file' => [$info]]);
        }
        $row = $media->store($file, $info, AdminBillingController::staff($request), $input['alt'] ?? null);

        return AdminPresenter::json(['data' => HelpMediaService::ref($row)], 201);
    }
}
