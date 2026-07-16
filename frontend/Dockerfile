# --- base: install once, reused by both dev and build stages ---
FROM node:20-alpine AS base
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci

# --- dev: local docker-compose target — Vite dev server with HMR ---
FROM base AS dev
COPY . .
EXPOSE 5173
CMD ["npm", "run", "dev", "--", "--host"]

# --- build: compile the static production bundle ---
FROM base AS build
COPY . .
# Vite inlines VITE_* into the compiled bundle at build time — passed as a
# build arg (not baked into image layers as ENV would be) since Sentry
# reporting is optional and unrelated to the runtime container config.
ARG VITE_SENTRY_DSN
ENV VITE_SENTRY_DSN=${VITE_SENTRY_DSN}
RUN npm run build

# --- prod: nginx serving the built static bundle ---
FROM nginx:1.29-alpine AS prod
# Pick up Alpine OS security patches (e.g. openssl, expat, libxml2) not yet
# baked into this image tag upstream — see docs/DEPLOYMENT.md "Container hardening".
RUN apk upgrade --no-cache \
  && apk del --no-cache curl 2>/dev/null; rm -rf /var/cache/apk/*
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.static.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
