<?php

declare(strict_types=1);

namespace App\Domain\Help\Admin;

use App\Domain\Admin\Tenants\AdminPresenter;
use App\Domain\Admin\Tenants\Http\AdminBillingController;
use App\Domain\Help\HelpCategoryService;
use App\Domain\Help\Http\Requests\UpdateHelpArticleRequest;
use App\Domain\Help\Models\HelpCategory;
use Illuminate\Http\JsonResponse;
use Illuminate\Http\Request;
use Illuminate\Http\Response;
use Illuminate\Validation\Rule;

/** `/admin/help-categories…` (PHASE-8-9C §7.2; `platform.can:manage_help_content`). */
class AdminHelpCategoryController
{
    public function __construct(private readonly HelpCategoryService $categories) {}

    public function index(): JsonResponse
    {
        return AdminPresenter::json(['data' => AdminHelpPresenter::categories($this->categories->all())]);
    }

    public function store(Request $request): JsonResponse
    {
        $input = $request->validate(self::rules(true));
        $c = $this->categories->create(AdminBillingController::staff($request), $input);

        return AdminPresenter::json(['data' => AdminHelpPresenter::categories([$c])[0]], 201);
    }

    public function update(Request $request, string $category): JsonResponse
    {
        $input = $request->validate(self::rules(false) + ['revision' => ['required', 'integer', 'min:1']]);
        $c = $this->categories->update($category, AdminBillingController::staff($request), $input);

        return AdminPresenter::json(['data' => AdminHelpPresenter::categories([$c])[0]]);
    }

    public function destroy(Request $request, string $category): Response
    {
        $this->categories->delete($category, AdminBillingController::staff($request));

        return response()->noContent();
    }

    public function reorder(Request $request): JsonResponse
    {
        $input = $request->validate(['ids' => ['required', 'array', 'max:'.HelpCategory::MAX], 'ids.*' => ['string', 'size:26']]);

        return AdminPresenter::json(['data' => AdminHelpPresenter::categories($this->categories->reorder(array_values($input['ids']), AdminBillingController::staff($request)))]);
    }

    /** @return array<string, list<mixed>> */
    private static function rules(bool $create): array
    {
        $req = $create ? 'required' : 'sometimes';

        return [
            'slug' => [$req, 'string', 'max:60', UpdateHelpArticleRequest::SLUG],
            'name_en' => [$req, 'string', 'max:60'],
            'name_bn' => ['sometimes', 'nullable', 'string', 'max:60'],
            'description_en' => ['sometimes', 'nullable', 'string', 'max:160'],
            'description_bn' => ['sometimes', 'nullable', 'string', 'max:160'],
            'icon' => [$req, Rule::in(HelpCategory::ICONS)],
        ];
    }
}
