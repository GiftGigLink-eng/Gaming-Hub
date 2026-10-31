# Multi-stage production Dockerfile for Gaming Hub (React/Vite SPA + Node.js Express Backend)
# Targeted for Google Cloud Run (Container Port: $PORT, default 8080)

# ----------------------------------------------------
# Stage 1: Build Frontend Assets
# ----------------------------------------------------
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies first for Docker layer caching
COPY package.json package-lock.json* bun.lock* ./
RUN npm ci || npm install

# Copy source code and configuration required for Vite build
COPY tsconfig.json vite.config.ts index.html firebase-applet-config.json ./
COPY public ./public
COPY src ./src

# Build the client SPA into /app/dist
RUN npm run build

# ----------------------------------------------------
# Stage 2: Production Runtime
# ----------------------------------------------------
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=8080

# Install production dependencies only
COPY package.json package-lock.json* bun.lock* ./
RUN npm ci --only=production || npm install --omit=dev

# Copy server entrypoint and source files
COPY server.ts tsconfig.json firebase-applet-config.json firebase-blueprint.json firestore.rules ./
COPY src/server ./src/server
COPY src/types.ts ./src/types.ts
COPY src/lib/nativeBroadcaster.ts ./src/lib/nativeBroadcaster.ts

# Copy built frontend assets from builder stage into /app/dist
COPY --from=builder /app/dist ./dist

# Create non-root user for container security hardening
RUN addgroup -S appgroup && adduser -S appuser -G appgroup && chown -R appuser:appgroup /app
USER appuser

# Expose standard Cloud Run port
EXPOSE 8080

# Launch Express server in production mode
CMD ["npm", "start"]
