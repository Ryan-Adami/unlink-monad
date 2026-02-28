FROM node:22-bookworm-slim

WORKDIR /app

RUN corepack enable

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/unlink-client/package.json packages/unlink-client/package.json

RUN pnpm install --prod --frozen-lockfile --filter @repo/unlink-client...

COPY packages/unlink-client packages/unlink-client
COPY apps/pusd-demo-worker/container apps/pusd-demo-worker/container

ENV PORT=3000
ENV UNLINK_STATE_DIR=/tmp/unlink-state

EXPOSE 3000

CMD ["node", "--experimental-strip-types", "apps/pusd-demo-worker/container/server.ts"]
