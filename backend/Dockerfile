# --- deps: install once, reused by both build and runtime stages ---
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

# --- build: compile TypeScript to dist/ ---
FROM deps AS build
COPY . .
RUN npm run build

# --- prod-deps: production node_modules only, built in a stage that still has npm ---
FROM node:20-alpine AS prod-deps
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev

# --- runtime: bare node, no npm/npx/corepack — nothing here ever invokes them ---
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
# Pick up Alpine OS security patches (e.g. openssl) not yet baked into this
# image tag upstream — see docs/DEPLOYMENT.md "Container hardening".
RUN apk upgrade --no-cache \
  && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=prod-deps /app/package.json ./package.json
COPY --from=build /app/dist ./dist

EXPOSE 4000
CMD ["node", "dist/index.js"]
