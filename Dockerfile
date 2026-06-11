FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npx playwright install chromium
RUN npm run build

FROM node:22-alpine AS production
WORKDIR /app
RUN apk add --no-cache chromium
COPY --from=build /app/dist ./dist
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/package.json ./
ENV QWEN_GATE_PORT=26405
EXPOSE 26405
VOLUME [ "/app/.qwen" ]
CMD [ "node", "dist/index.js" ]
