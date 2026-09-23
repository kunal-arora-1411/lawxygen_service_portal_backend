# syntax=docker/dockerfile:1

# The API image.
#
# `slim` rather than `alpine`: @node-rs/argon2 is a native module, and Debian's glibc
# avoids the musl prebuild question entirely. Password hashing is not somewhere to
# discover a platform difference in production.

# ---- Build ------------------------------------------------------------------
FROM node:24-slim AS build

WORKDIR /app

# Dependencies first, so a source-only change does not re-run npm ci.
COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json drizzle.config.ts ./
COPY src ./src

RUN npm run build

# ---- Migrate ----------------------------------------------------------------
# The migration runner, as its own target.
#
# drizzle-kit is a devDependency, so it cannot be installed into the runtime stage:
# `npm install drizzle-kit` under `--omit=dev` is a no-op, which is exactly the trap
# this layout avoids. The build stage already has the full dependency tree and the
# migration history, so migrations run from here — once, in a one-off container — and
# the image that serves traffic stays free of build tooling.
FROM build AS migrate

CMD ["npm", "run", "db:migrate"]

# ---- Runtime ----------------------------------------------------------------
FROM node:24-slim AS runtime

# Labelled so the deploy can prune its own leftovers by filter. This host is shared with
# other projects, and a blanket `docker image prune` would collect their dangling layers
# as well as ours.
LABEL org.opencontainers.image.title="lawxygen-api"

ENV NODE_ENV=production

WORKDIR /app

# Production dependencies only. Nothing here runs migrations, so nothing here needs
# drizzle-kit, the migration SQL or the Drizzle config.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist

# Drop privileges. The `node` user ships with the image and owns nothing here, which is
# the point — the application has no reason to write to its own code.
USER node

EXPOSE 4000

# No HEALTHCHECK here: compose defines it, so the interval and start period live beside
# the rest of the deployment rather than being baked into the image.

CMD ["node", "dist/server.js"]
