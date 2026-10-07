# ---- build stage: install all deps, build SPA + bundled server
FROM node:22-bookworm-slim AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev

# ---- runtime stage: production deps + built output only, non-root user
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=8080 \
    STATIC_DIR=/app/dist \
    UPLOAD_DIR=/data/uploads \
    BACKUP_DIR=/data/backups \
    MIGRATIONS_DIR=/app/migrations
WORKDIR /app
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/dist-server ./dist-server
COPY --from=build /app/migrations ./migrations
COPY --from=build /app/package.json ./package.json
# /data/backups: private backup archives (separate volume, never served); owned by the app user
RUN mkdir -p /data/uploads /data/backups && chown -R node:node /data && chmod 700 /data/backups
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "dist-server/index.js"]
