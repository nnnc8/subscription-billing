FROM node:22-slim AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

FROM base AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm run build

FROM base AS runtime
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/server.ts ./server.ts
COPY --from=build /app/server ./server
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/lib ./lib
COPY --from=build /app/scripts ./scripts
COPY --from=build /app/fixtures ./fixtures
COPY --from=build /app/com.nc8.subscription-billing.plist ./
RUN install -d -o node -g node /data /pnpm
ENV NODE_ENV=production \
    DATA_DIR=/data
EXPOSE 3000
USER node
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3000') + '/api/health').then(response => { if (!response.ok) process.exit(1) }).catch(() => process.exit(1))"
CMD ["pnpm", "start"]
