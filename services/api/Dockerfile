FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY bin ./bin
COPY config ./config
COPY scripts ./scripts
COPY services/api/package.json ./services/api/package.json
COPY services/worker/package.json ./services/worker/package.json

ENV DEV_CREW_SKIP_CLI_PATH_SETUP=1

RUN npm install

COPY services/api ./services/api

RUN npm run build -w services/api

FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production
ENV HOME=/app

RUN apk add --no-cache bash ca-certificates openssh && update-ca-certificates

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/config ./config
COPY --from=builder /app/services/api/package.json ./services/api/package.json
COPY --from=builder /app/services/api/dist ./services/api/dist

EXPOSE 8080
CMD ["node", "services/api/dist/main.js"]
