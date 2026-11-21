FROM node:22-bookworm-slim AS dependencies

WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssl \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY prisma/schema.prisma ./prisma/
RUN npm ci --no-audit --no-fund \
    && npm cache clean --force \
    && rm -rf /root/.cache/prisma

FROM dependencies AS build

COPY next.config.ts postcss.config.mjs tsconfig.json instrumentation.ts ./
COPY app ./app
COPY components ./components
COPY lib ./lib
COPY public ./public

RUN npm run build && rm -rf .next/cache

FROM dependencies AS runtime

ENV NODE_ENV=production \
    DATABASE_URL=file:/app/data/sqlite/citybuddy.db

RUN install -d -o node -g node /app/data/sqlite

COPY next.config.ts tsconfig.json ./
COPY prisma/migrations ./prisma/migrations
COPY scripts/db.mjs ./scripts/db.mjs
COPY --from=build /app/public ./public
COPY --from=build --chown=node:node /app/.next ./.next

USER node
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
    CMD ["node", "-e", "fetch('http://127.0.0.1:3000/').then(response => process.exit(response.ok ? 0 : 1), () => process.exit(1))"]

CMD ["sh", "-c", "node scripts/db.mjs && exec ./node_modules/.bin/next start --hostname 0.0.0.0 --port 3000"]
