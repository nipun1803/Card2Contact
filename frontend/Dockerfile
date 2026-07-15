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
RUN npm run build

# --- prod: nginx serving the built static bundle ---
FROM nginx:1.27-alpine AS prod
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.static.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
