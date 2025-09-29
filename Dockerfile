FROM node:18-alpine AS builder
WORKDIR /app

RUN apk add --no-cache python3 make g++

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

FROM node:18-alpine
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY server ./server
COPY public ./public
COPY data ./data

RUN mkdir -p /app/credentials

ENV NODE_ENV=production \
    PORT=3000 \
    DB_DIR=/app/data \
    GOOGLE_OAUTH_CREDENTIALS=/app/credentials/google-oauth.json \
    GOOGLE_OAUTH_TOKEN=/app/credentials/google-token.json

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get('http://localhost:3000/api/health',(r)=>{process.exit(r.statusCode===200?0:1)})"

CMD ["node", "server/index.js"]

LABEL org.opencontainers.image.title="ralphmagchatbot" \
      org.opencontainers.image.description="RAG chatbot for Ralph Magazine"
