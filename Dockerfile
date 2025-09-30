# syntax=docker/dockerfile:1.6
FROM node:22-alpine AS base
WORKDIR /app

# Mínimos para prisma
RUN apk add --no-cache openssl

# Instalar dependencias
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev=false

# Copiar código
COPY tsconfig.json ./
COPY prisma ./prisma
COPY src ./src
COPY assets ./assets
COPY index.html styles.css app.js demo-mapa-real.html ./

# Generar Prisma Client y compilar TS
RUN npx prisma generate
RUN npm run build

# Runtime (prod)
FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production

RUN apk add --no-cache openssl

COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/dist ./dist
COPY --from=base /app/assets ./assets
COPY --from=base /app/index.html ./
COPY --from=base /app/styles.css ./
COPY --from=base /app/app.js ./
COPY --from=base /app/demo-mapa-real.html ./

EXPOSE 4000
CMD ["node","dist/server.js"]
