FROM node:24-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build && npm prune --omit=dev
# Bake a warm data cache into the image; the app still refreshes it in the background.
RUN node scripts/prefetch.ts || echo "prefetch skipped"
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787
EXPOSE 8787
CMD ["node", "server/index.ts"]
