# Stage 1: Build dependencies and compiled JavaScript
FROM node:24-alpine AS builder

WORKDIR /app

# Copy root monorepo manifests
COPY package.json package-lock.json tsconfig.base.json ./
COPY shared/package.json ./shared/
COPY backend/package.json ./backend/

# Install all dependencies (including devDependencies needed for build)
RUN npm ci

# Copy source trees
COPY shared ./shared
COPY backend ./backend

# Build shared and backend workspaces
RUN npm run build --workspace=@ledgerguard/shared
RUN npm run build --workspace=@ledgerguard/backend

# Stage 2: Production runtime image
FROM node:24-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=7860

# Install dumb-init for proper PID 1 signal forwarding
RUN apk add --no-cache dumb-init

# Copy workspace package manifests
COPY package.json package-lock.json ./
COPY shared/package.json ./shared/
COPY backend/package.json ./backend/

# Install production dependencies only
RUN npm ci --omit=dev

# Copy built artifacts from builder stage
COPY --from=builder /app/shared/dist ./shared/dist
COPY --from=builder /app/backend/dist ./backend/dist

# Switch to non-root node user
USER node

EXPOSE 7860

# Launch with dumb-init
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "backend/dist/server.js"]
