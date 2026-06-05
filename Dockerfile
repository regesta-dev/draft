FROM node:24-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm build

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4321
ENV REGESTA_DATA_DIR=/data
RUN mkdir -p /data && chown -R node:node /data /app
COPY --from=build --chown=node:node /app/apps/server/.output ./apps/server/.output
USER node
VOLUME ["/data"]
EXPOSE 4321
CMD ["node", "apps/server/.output/server/index.mjs"]
