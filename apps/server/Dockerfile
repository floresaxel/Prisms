# Prisms API image (Hono + Better Auth + pg-boss jobs). Built from the repo
# root context so the pnpm workspace (core, db, server) resolves.
# syntax=docker/dockerfile:1
FROM node:20-bookworm-slim

WORKDIR /app
RUN npm install -g pnpm@11.5.3

# Install only the server's workspace subtree (server + core + db + their deps).
COPY . .
RUN pnpm install --frozen-lockfile --filter "@prisms/server..."

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

# Apply forward-only migrations, then serve the API + start pg-boss jobs.
CMD ["sh", "-c", "pnpm --filter @prisms/db db:migrate && pnpm --filter @prisms/server start"]
