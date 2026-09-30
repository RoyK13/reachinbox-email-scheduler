# Single-service image: API + email worker + built React frontend.
# Used by Railway (see railway.json); works on any Docker host.

# ---- build ------------------------------------------------------------------
FROM node:22-bookworm-slim AS build
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app

COPY backend/package.json backend/package-lock.json backend/
COPY frontend/package.json frontend/package-lock.json frontend/
RUN npm ci --prefix backend --no-audit --no-fund && npm ci --prefix frontend --no-audit --no-fund

COPY backend backend
COPY frontend frontend
# Frontend talks to /api on the same origin in production (see frontend/src/services/api.ts).
RUN npm run build --prefix frontend \
 && cd backend && npx prisma generate && npm run build && npm prune --omit=dev

# ---- runtime ----------------------------------------------------------------
FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /app

COPY --from=build /app/backend/package.json backend/package.json
COPY --from=build /app/backend/node_modules backend/node_modules
COPY --from=build /app/backend/dist backend/dist
COPY --from=build /app/backend/prisma backend/prisma
COPY --from=build /app/frontend/dist frontend/dist

WORKDIR /app/backend
USER node
EXPOSE 4000
# Apply pending migrations, then run API + worker (+ static frontend) together.
CMD ["sh", "-c", "npx prisma migrate deploy && node dist/all.js"]
