# syntax=docker/dockerfile:1.7
#
# battle-arena-realtime packaged as an AWS Lambda container image (Node.js 22 managed runtime base)
# for API Gateway WebSocket routes. Build context: ../battle-arena-realtime.
#
# The persistent WebSocket server (src/index.ts, ../battle-arena-realtime/Dockerfile) is not used
# here; the handler is dist/lambda/handler.js. The base image includes the Lambda Runtime
# Interface Emulator, so the same image runs locally and in Lambda.

FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
# Bundle the AWS SDK clients pinned in package.json (devDependencies of the persistent server)
# instead of relying on whatever SDK version the managed runtime happens to ship.
RUN npm run build \
    && SDK_MGMT="$(node -p "require('./package.json').devDependencies['@aws-sdk/client-apigatewaymanagementapi']")" \
    && SDK_LAMBDA="$(node -p "require('./package.json').devDependencies['@aws-sdk/client-lambda']")" \
    && npm prune --omit=dev --no-audit --no-fund \
    && npm install --no-save --omit=dev --no-audit --no-fund \
        "@aws-sdk/client-apigatewaymanagementapi@${SDK_MGMT}" "@aws-sdk/client-lambda@${SDK_LAMBDA}"

FROM public.ecr.aws/lambda/nodejs:22 AS lambda
COPY --from=build /app/package.json ${LAMBDA_TASK_ROOT}/package.json
COPY --from=build /app/node_modules ${LAMBDA_TASK_ROOT}/node_modules
COPY --from=build /app/dist ${LAMBDA_TASK_ROOT}/dist
CMD ["dist/lambda/handler.handler"]
