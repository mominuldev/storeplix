# syntax=docker/dockerfile:1
# Store Plix API — PHP-FPM 8.4.
#   Production image (default target "app"): php-fpm on :9000, put Nginx in front.
#   Dev target ("dev"): `php artisan serve` on :8000 for docker compose convenience.
# Build from apps/api:  docker build -t storeplix-api .            (php-fpm)
#                       docker build --target dev -t storeplix-api:dev .

FROM php:8.4-fpm-alpine AS base

RUN apk add --no-cache icu-libs libpq libzip postgresql-client \
    && apk add --no-cache --virtual .build-deps $PHPIZE_DEPS icu-dev postgresql-dev libzip-dev linux-headers \
    && docker-php-ext-install -j"$(nproc)" pdo_pgsql pgsql intl zip bcmath opcache pcntl \
    && pecl install redis \
    && docker-php-ext-enable redis \
    && apk del .build-deps \
    && rm -rf /tmp/pear

COPY --from=composer:2 /usr/bin/composer /usr/bin/composer
# Phase 4: 10 MB CSV imports (upload_max_filesize 12M, post_max_size 13M, memory for 5 000-row jobs).
COPY docker/php-uploads.ini /usr/local/etc/php/conf.d/zz-storeplix-uploads.ini

WORKDIR /var/www/html

# ---------- dependencies (cached layer) ----------
FROM base AS vendor
COPY composer.json composer.lock ./
RUN composer install --no-dev --no-interaction --no-scripts --no-autoloader --prefer-dist

# ---------- development ----------
FROM base AS dev
ENV APP_ENV=local APP_DEBUG=true LOG_CHANNEL=stderr
COPY composer.json composer.lock ./
RUN composer install --no-interaction --no-scripts --no-autoloader --prefer-dist
COPY . .
RUN composer dump-autoload --optimize && php artisan package:discover --ansi
EXPOSE 8000
CMD ["php", "artisan", "serve", "--host=0.0.0.0", "--port=8000"]

# ---------- production ----------
FROM base AS app
ENV APP_ENV=production APP_DEBUG=false LOG_CHANNEL=stderr
COPY --from=vendor /var/www/html/vendor ./vendor
COPY . .
RUN composer dump-autoload --optimize --no-dev --classmap-authoritative \
    && php artisan package:discover --ansi \
    && mkdir -p storage/framework/cache storage/framework/sessions storage/framework/views storage/logs bootstrap/cache \
    && chown -R www-data:www-data storage bootstrap/cache
USER www-data
EXPOSE 9000
CMD ["php-fpm"]
