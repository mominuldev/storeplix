<?php

declare(strict_types=1);

namespace App\Domain\Domains\Console;

use App\Domain\Domains\PublicSuffixes;
use App\Domain\Integrations\SafeHttpClient;
use Illuminate\Console\Command;
use Pdp\Rules;
use Throwable;

/** P6-4: refreshes the committed PSL snapshot (resources/data/public_suffix_list.dat). Commit the result. */
class UpdatePublicSuffixList extends Command
{
    protected $signature = 'domains:update-psl';

    protected $description = 'Download the Public Suffix List into resources/data';

    public function handle(SafeHttpClient $http): int
    {
        $url = (string) config('domains.psl_url');
        $parts = (array) parse_url($url);
        try {
            $response = $http->to(($parts['scheme'] ?? '').'://'.($parts['host'] ?? ''))->accept('text/plain')->get($parts['path'] ?? '/');
        } catch (Throwable) {
            $this->error('Download failed.');

            return self::FAILURE;
        }
        $body = $response->successful() ? $response->body() : '';
        if (! str_contains($body, '===BEGIN ICANN DOMAINS===') || ! str_contains($body, '===BEGIN PRIVATE DOMAINS===')) {
            $this->error('The download is not a Public Suffix List (HTTP '.$response->status().').');

            return self::FAILURE;
        }
        try {
            Rules::fromString($body);
        } catch (Throwable) {
            $this->error('The list does not parse.');

            return self::FAILURE;
        }
        $path = (string) config('domains.psl_path');
        file_put_contents($path.'.tmp', $body);
        rename($path.'.tmp', $path);
        PublicSuffixes::forget();
        $this->info('Updated '.$path.' ('.substr_count($body, "\n").' lines).');

        return self::SUCCESS;
    }
}
