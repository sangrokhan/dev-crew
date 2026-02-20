FROM node:20-alpine AS builder
WORKDIR /app

COPY package.json tsconfig.base.json ./
COPY prisma ./prisma
COPY services/api/package.json ./services/api/package.json
COPY services/worker/package.json ./services/worker/package.json

RUN npm install

COPY services/worker ./services/worker

RUN npm run prisma:generate
RUN npm run build -w services/worker

FROM node:20-alpine AS runtime
WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache bash git tmux

COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/services/worker/package.json ./services/worker/package.json
COPY --from=builder /app/services/worker/dist ./services/worker/dist

CMD ["node", "services/worker/dist/index.js"]
