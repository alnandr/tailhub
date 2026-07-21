# syntax=docker/dockerfile:1
# Build the workspace, then ship only the hub's dist (zero runtime deps, so
# the final image is node:alpine + ~a dozen JS files).

FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY packages/client/package.json packages/client/
COPY packages/hub/package.json packages/hub/
RUN npm ci
COPY tsconfig.base.json ./
COPY packages ./packages
RUN npm run build

FROM node:22-alpine
# Inside a container the container boundary replaces the loopback-bind
# default; publish the port carefully (see docs/docker.md — the recommended
# deployment shares a Tailscale sidecar's network namespace instead of
# publishing to the host).
ENV NODE_ENV=production \
    TAILHUB_HOST=0.0.0.0 \
    TAILHUB_PORT=4747 \
    TAILHUB_DATA_DIR=/data
COPY --from=build /src/packages/hub/dist /app
RUN mkdir -p /data && chown node:node /data
VOLUME /data
EXPOSE 4747
USER node
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.TAILHUB_PORT||4747)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["node", "/app/cli.js"]
CMD ["start"]
