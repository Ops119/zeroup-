FROM node:22-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build && npx tsc -p .
ENV HOST=0.0.0.0
# docker run --env-file .env -p 4010:4010 zeroup sponsor
ENTRYPOINT ["npx", "tsx", "src/bin/serve.ts"]
