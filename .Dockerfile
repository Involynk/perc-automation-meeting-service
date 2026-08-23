# ── Stage 1: Builder ──
FROM node:22-alpine AS builder

WORKDIR /app

# Copy package files for dependency resolution
COPY package*.json ./
COPY tsconfig*.json ./
COPY nest-cli.json ./
COPY packages/ ./packages/

# Install all dependencies
RUN npm install

# Build shared library and meeting service
RUN npm run build

# ── Stage 2: Runner (Production) ──
FROM node:22-alpine AS runner

WORKDIR /app
ENV NODE_ENV=production

# Copy built artifacts and node_modules
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist

EXPOSE 3004

CMD ["npm", "run", "start"]
