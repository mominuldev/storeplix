<?php

namespace App\Domain\Documents;

use App\Domain\Documents\Console\PruneDocuments;
use App\Domain\Documents\Drivers\DocumentDriver;
use App\Domain\Documents\Drivers\GotenbergClient;
use App\Domain\Documents\Drivers\HtmlDriver;
use Illuminate\Support\ServiceProvider;

/** Phase 5b-4 documents: driver binding (DOCUMENTS_DRIVER) and the retention command. */
class DocumentsServiceProvider extends ServiceProvider
{
    public function register(): void
    {
        $this->app->bind(DocumentDriver::class, fn () => config('documents.driver') === 'gotenberg' ? new GotenbergClient : new HtmlDriver);
    }

    public function boot(): void
    {
        if ($this->app->runningInConsole()) {
            $this->commands([PruneDocuments::class]);
        }
    }
}
