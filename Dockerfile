FROM node:24-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile

FROM deps AS build
ARG REGESTA_BUILD_TIME
ARG REGESTA_GIT_DIRTY
ARG REGESTA_GIT_SHA
ENV REGESTA_BUILD_TIME=$REGESTA_BUILD_TIME
ENV REGESTA_GIT_DIRTY=$REGESTA_GIT_DIRTY
ENV REGESTA_GIT_SHA=$REGESTA_GIT_SHA
ENV NITRO_PRESET=node_server
COPY . .
RUN pnpm --filter @regesta/server build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV NITRO_PRESET=node_server
ENV PORT=4321
ENV REGESTA_DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data /app
COPY --from=build --chown=node:node /app/apps/server/.output ./apps/server/.output
USER node
VOLUME ["/data"]
EXPOSE 4321
CMD ["node", "apps/server/.output/server/index.mjs"]
