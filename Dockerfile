# syntax=docker/dockerfile:1

FROM node:24-alpine AS build
RUN corepack enable
WORKDIR /app

# Install dependencies first so they are cached independently of source changes
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY web/package.json web/
RUN --mount=type=cache,target=/root/.local/share/pnpm/store \
    pnpm install --frozen-lockfile --filter=web

# The PUBLIC_GITHUB_* values from web/.env are inlined into the client bundle here
COPY web web
RUN ADAPTER=node pnpm --filter=web run build \
    && pnpm --filter=web deploy --prod --legacy /deploy

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /deploy/node_modules node_modules
COPY --from=build /app/web/build build
COPY --from=build /app/web/package.json .
EXPOSE 3000
USER node
CMD ["node", "build"]
