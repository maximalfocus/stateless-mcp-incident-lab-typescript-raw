# syntax=docker/dockerfile:1.7
FROM node:24-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json eslint.config.js vitest.config.ts cdd-manifest.json ./
COPY src ./src
COPY test ./test
RUN npm run typecheck && npm run build

FROM builder AS test
COPY --from=conformance / /external-conformance
ENV CONFORMANCE_PATH=/external-conformance/conformance
RUN test -f "$CONFORMANCE_PATH/protocol/001-valid-request-shape/test.json"
RUN npm run lint && npm test && npm run test:conformance -- --discover-only

FROM node:24-alpine AS runtime
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY --from=builder /app/dist/src ./dist
USER node
ENTRYPOINT ["node", "dist/main.js"]
CMD ["--version"]
