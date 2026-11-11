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
# token the shared workflow passes as a BuildKit SECRET (never a build-arg or an
# image layer). Other deps use public npmjs. Locally:
#   docker build --secret id=gh_packages_token,env=GH_PACKAGES_READ_TOKEN
RUN --mount=type=secret,id=gh_packages_token \
    printf '@sudobility:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=%s\n' \
      "$(cat /run/secrets/gh_packages_token)" > ~/.npmrc && \
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

# Install curl for health checks, ca-certificates for HTTPS, and adduser for the
# addgroup/adduser commands (not preinstalled in Debian trixie slim).
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl \
    ca-certificates \
    adduser \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Create non-root user for security
RUN addgroup --system --gid 1001 nodejs && \
    adduser --system --uid 1001 botuser

# Copy production dependencies only (token via BuildKit secret; see above).
COPY package.json bun.lock ./
RUN --mount=type=secret,id=gh_packages_token \
    printf '@sudobility:registry=https://npm.pkg.github.com\n//npm.pkg.github.com/:_authToken=%s\n' \
      "$(cat /run/secrets/gh_packages_token)" > ~/.npmrc && \
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
