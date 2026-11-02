FROM node:22-alpine AS build
WORKDIR /app
COPY package.json ./
RUN npm install --no-audit --no-fund
COPY . .
RUN npm run build

FROM node:22-alpine AS api
RUN apk add --no-cache ffmpeg
ENV NODE_ENV=production
WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev --no-audit --no-fund
COPY server ./server
COPY scripts ./scripts
RUN mkdir -p /app/uploads/private-photos /app/uploads/private-identity-l3 /run/identity-l3-tmp && chmod 700 /app/uploads/private-identity-l3 /run/identity-l3-tmp && chown -R node:node /app /run/identity-l3-tmp
USER node
EXPOSE 3001
CMD ["npm", "run", "start:api"]

FROM nginx:1.28-alpine AS web
COPY docker/nginx.conf /etc/nginx/conf.d/default.conf
RUN nginx -t
COPY --from=build /app/dist /usr/share/nginx/html
EXPOSE 80
HEALTHCHECK --interval=30s --timeout=3s --start-period=10s --retries=3 CMD wget -q -O /dev/null http://127.0.0.1/healthz || exit 1
