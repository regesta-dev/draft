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
ENV REGESTA_HOST=0.0.0.0
ENV REGESTA_PORT=4321
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages ./packages
COPY apps ./apps
RUN pnpm install --prod --frozen-lockfile
COPY --from=build /app/packages ./packages
COPY --from=build /app/apps ./apps
EXPOSE 4321
CMD ["node", "apps/server/dist/index.mjs"]
