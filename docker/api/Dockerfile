# syntax=docker/dockerfile:1.7
#
# Battle Arena API as an AWS Lambda container image (Bref v3, PHP 8.4).
#
# Build context:      ../battle-arena-api (application source; nothing is written back to it)
# Additional context: lambda = ./docker/api (PHP ini shipped inside the Lambda artifact)
#
# Targets (same artifact, different Bref runtime):
#   fpm     -> HTTP function behind API Gateway HTTP API          (BREF_RUNTIME=fpm)
#   console -> artisan function invoked by the EventBridge schedule (BREF_RUNTIME=console)
#
# Build argument COMPOSER_DEV:
#   1 (default, local development) -> require-dev included (PHPUnit, Telescope, Pint, Larastan)
#   0 (production artifact)        -> --no-dev, classmap-authoritative autoloader
#
# The Bref base image contains the AWS Lambda Runtime Interface Emulator
# (/usr/local/bin/aws-lambda-rie), so the same image runs locally and as a Lambda container image.

ARG BREF_MAJOR=3

FROM composer:2 AS composer

# ---------------------------------------------------------------------------
# Vendor stage. bref/bref + bref/laravel-bridge are added to this build copy only; the API
# repository's composer.json / composer.lock are not modified (see README, remaining work).
# ---------------------------------------------------------------------------
FROM php:8.4-cli-bookworm AS vendor
ARG COMPOSER_DEV=1
RUN apt-get update \
    && apt-get install -y --no-install-recommends git unzip libzip-dev libicu-dev \
    && docker-php-ext-install zip intl \
    && rm -rf /var/lib/apt/lists/*
COPY --from=composer /usr/bin/composer /usr/bin/composer
ENV COMPOSER_ALLOW_SUPERUSER=1
WORKDIR /var/task

COPY . .

# Never package local data, caches, logs or secrets into a Lambda artifact.
RUN rm -rf .env .env.* .github .cursor node_modules vendor NUL \
        storage/logs/* storage/framework/cache/* storage/framework/sessions/* \
        storage/framework/views/* storage/framework/testing storage/app/profiles/* \
        storage/app/private/* storage/app/public/* bootstrap/cache/*.php .phpunit.result.cache \
    && if [ "$COMPOSER_DEV" = "1" ]; then \
         composer install --prefer-dist --no-interaction --no-progress --no-scripts \
         && composer require --no-interaction --no-progress --no-scripts \
              "bref/bref:^3.0.16" "bref/laravel-bridge:^3.1" \
         && composer dump-autoload --no-scripts; \
       else \
         rm -rf tests phpunit*.xml phpstan* \
         && composer install --no-dev --prefer-dist --no-interaction --no-progress --no-scripts \
         && composer require --update-no-dev --no-interaction --no-progress --no-scripts \
              "bref/bref:^3.0.16" "bref/laravel-bridge:^3.1" \
         && composer dump-autoload --no-dev --optimize --classmap-authoritative --no-scripts; \
       fi \
    && export APP_KEY=base64:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA= APP_ENV=production \
    && php artisan package:discover --ansi \
    && php artisan route:cache \
    && php artisan event:cache

# ---------------------------------------------------------------------------
# GD is not part of the Bref core runtime; the avatar pipeline needs it.
# ---------------------------------------------------------------------------
FROM bref/extra-gd-php-84:${BREF_MAJOR} AS gd

FROM bref/php-84:${BREF_MAJOR} AS runtime-base
COPY --from=gd /opt /opt
COPY --from=vendor /var/task /var/task
COPY --from=lambda php/conf.d /var/task/php/conf.d
# Fail the build if the Lambda runtime lacks an extension the production lock file requires.
COPY --from=composer /usr/bin/composer /tmp/composer
RUN php /tmp/composer check-platform-reqs --no-dev --working-dir=/var/task \
    && php -m | grep -qi '^gd$' \
    && php -m | grep -qi '^pdo_pgsql$' \
    && rm /tmp/composer

# ---------------------------------------------------------------------------
# HTTP function (PHP-FPM runtime)
# ---------------------------------------------------------------------------
FROM runtime-base AS fpm
ENV BREF_RUNTIME=fpm
CMD ["public/index.php"]

# ---------------------------------------------------------------------------
# Console function (artisan)
# ---------------------------------------------------------------------------
FROM runtime-base AS console
ENV BREF_RUNTIME=console
CMD ["artisan"]
