# syntax=docker/dockerfile:1.7
#
# React production build served the way S3 + CloudFront would serve it (local stand-in).
# Build context: ../battle-arena-web. Additional context "nginx-config": ./docker/web.

FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
# Vite inlines VITE_* at build time, exactly like the CI build that would upload to S3.
ARG VITE_API_BASE_URL
ENV VITE_API_BASE_URL=${VITE_API_BASE_URL}
RUN test -n "$VITE_API_BASE_URL" && npm run build

FROM nginx:1.28-alpine AS cdn
COPY --from=nginx-config nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
