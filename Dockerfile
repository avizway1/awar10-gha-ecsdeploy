# syntax=docker/dockerfile:1.7

###############################################################################
# To-Do list app -- production image
#
# Multi-stage build:
#   base    -> pinned Node runtime, shared by every other stage
#   deps    -> production dependencies only (installed from the lockfile)
#   runner  -> final image: non-root, minimal, health-checked
#
# Build:  docker build -t todo-app:1.0.0 .
# Run:    docker run -d -p 3000:3000 -e AWS_REGION=ap-south-1 -e TABLE_NAME=todo-tasks \
#           -v ~/.aws:/home/node/.aws:ro --name todo-app todo-app:1.0.0
###############################################################################

# Pin the base image. This defaults to the current Node 22 LTS Alpine tag so
# the build works out of the box. For a regulated pipeline, override it with an
# immutable digest and let Renovate/Dependabot bump it, e.g.:
#   docker build --build-arg NODE_VERSION=22-alpine@sha256:<digest> .
ARG NODE_VERSION=22-alpine


###############################################################################
# Stage 1 - base
###############################################################################
FROM node:${NODE_VERSION} AS base

# dumb-init gives us a real PID 1: it reaps zombies and forwards SIGTERM/SIGINT
# so `docker stop` and Kubernetes rolling updates shut the app down cleanly.
# Pin to an exact apk version (dumb-init=1.2.5-r3) once you have settled on a
# base image digest -- the available version follows the Alpine release.
RUN apk add --no-cache dumb-init

ENV NODE_ENV=production \
    NPM_CONFIG_UPDATE_NOTIFIER=false \
    NPM_CONFIG_FUND=false \
    NPM_CONFIG_AUDIT=false

WORKDIR /app


###############################################################################
# Stage 2 - deps (production node_modules)
###############################################################################
FROM base AS deps

# Copy only the manifests first: this layer is re-used on every build where
# package.json / package-lock.json have not changed.
COPY package.json package-lock.json ./

# `npm ci` installs exactly what the lockfile pins -- reproducible builds.
# The cache mount keeps the npm cache out of the image layers.
RUN --mount=type=cache,target=/root/.npm,sharing=locked \
    npm ci --omit=dev --ignore-scripts \
 && npm cache clean --force


###############################################################################
# Stage 3 - runner (final image)
###############################################################################
FROM base AS runner

# Build metadata, passed in by CI. Kept in the last stage so changing them
# does not invalidate the dependency cache.
ARG APP_VERSION=1.0.0
ARG VCS_REF=unknown
ARG BUILD_DATE=unknown

LABEL org.opencontainers.image.title="todo-list-app" \
      org.opencontainers.image.description="Simple To-Do list web app (Node.js + Express, Amazon DynamoDB storage)" \
      org.opencontainers.image.version="${APP_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      org.opencontainers.image.created="${BUILD_DATE}" \
      org.opencontainers.image.vendor="Aviz Academy" \
      org.opencontainers.image.licenses="MIT" \
      org.opencontainers.image.base.name="docker.io/library/node:${NODE_VERSION}"

# TABLE_NAME / AWS_REGION are set by the ECS task definition (or `docker run -e`).
ENV PORT=3000 \
    TABLE_NAME=todo-tasks

# node_modules first (changes rarely), application code second (changes often).
# --chown avoids a second copy-on-write layer just to fix ownership.
COPY --chown=node:node --from=deps /app/node_modules ./node_modules
COPY --chown=node:node package.json server.js ./
COPY --chown=node:node public ./public

# The `node` user (uid/gid 1000) ships with the official image. Running as a
# non-root, numeric UID satisfies Kubernetes `runAsNonRoot` admission policies.
USER node

EXPOSE 3000

# Liveness probe on /health (does not call DynamoDB). Uses the runtime already
# in the image -- no curl/wget needed, so nothing extra is added to the attack
# surface.
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "server.js"]
