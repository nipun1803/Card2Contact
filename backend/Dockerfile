# --- deps: install once, reused by both build and runtime stages ---
FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install

# --- build: compile TypeScript to dist/ ---
FROM deps AS build
COPY . .
RUN npm run build

# --- runtime: production deps only + compiled output ---
FROM node:20-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist

EXPOSE 4000
CMD ["node", "dist/index.js"]
