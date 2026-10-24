# syntax=docker/dockerfile:1

# =============================================================================
# Sudojo Bot - Multi-stage Docker Build
# Compatible with sudobility_dockerized deployment scripts
# =============================================================================

# -----------------------------------------------------------------------------
# Stage 1: Install dependencies
# -----------------------------------------------------------------------------
FROM oven/bun:1 AS deps

WORKDIR /app

# Copy package files
COPY package.json bun.lock ./

# Install all dependencies (including devDependencies for build).
# @sudobility packages live on GitHub Packages; route the scope there with the
# GH_PACKAGES_TOKEN build-arg the shared workflow passes. Other deps use public npmjs.
ARG GH_PACKAGES_TOKEN
RUN echo "@sudobility:registry=https://npm.pkg.github.com" > ~/.npmrc && \
    echo "//npm.pkg.github.com/:_authToken=${GH_PACKAGES_TOKEN}" >> ~/.npmrc && \
    bun install --frozen-lockfile && \
    rm -f ~/.npmrc

# -----------------------------------------------------------------------------
# Stage 2: Build TypeScript
# -----------------------------------------------------------------------------
FROM oven/bun:1 AS builder

WORKDIR /app

# Copy dependencies from deps stage
COPY --from=deps /app/node_modules ./node_modules

# Copy source files
COPY package.json bun.lock tsconfig.json ./
COPY src ./src

# Build TypeScript
RUN bun run build

# -----------------------------------------------------------------------------
# Stage 3: Production image
# -----------------------------------------------------------------------------
FROM oven/bun:1-slim AS production

# Install curl for health checks and ca-certificates for HTTPS
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 botuser

# Copy production dependencies only
COPY package.json bun.lock ./
ARG GH_PACKAGES_TOKEN
RUN echo "@sudobility:registry=https://npm.pkg.github.com" > ~/.npmrc && \
    echo "//npm.pkg.github.com/:_authToken=${GH_PACKAGES_TOKEN}" >> ~/.npmrc && \
    bun install --frozen-lockfile --production && \
    rm -f ~/.npmrc && \
    rm -rf ~/.bun/install/cache

# Copy built application
COPY --from=builder /app/dist ./dist

# Copy source for Bun runtime (Bun runs TS directly, dist is for type checking)
COPY --from=builder /app/src ./src

# Set ownership
RUN chown -R botuser:nodejs /app

# Switch to non-root user
USER botuser

# Environment defaults (override via .env or docker-compose)
ENV NODE_ENV=production
ENV PORT=3978

# Expose the bot port
EXPOSE 3978

# Health check for Traefik and container orchestration
HEALTHCHECK --interval=30s --timeout=15s --start-period=30s --retries=3 \
    CMD curl -f http://localhost:${PORT}/health || exit 1

# Start the bot
CMD ["bun", "run", "src/index.ts"]
