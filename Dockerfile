FROM node:22-alpine AS builder

RUN corepack enable && corepack prepare pnpm@latest --activate

WORKDIR /app

# Install dependencies
COPY package.json pnpm-lock.yaml* ./
RUN pnpm install --frozen-lockfile 2>/dev/null || pnpm install

# Copy source and build
COPY . .
RUN pnpm build

# --- Production ---
FROM node:22-alpine

RUN apk add --no-cache tini

WORKDIR /app

# Copy built app and production deps
COPY --from=builder /app/build ./build
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Create data directory for SQLite
RUN mkdir -p /app/data && chown -R node:node /app

USER node

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV DATABASE_PATH=/app/data/merge-queue.db

EXPOSE 3000

VOLUME /app/data

ENTRYPOINT ["tini", "--"]
CMD ["node", "build/index.js"]
