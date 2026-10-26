# Landing page image: only the static site, no project dependencies.
FROM node:22-alpine
WORKDIR /app
COPY site/ ./
ENV NODE_ENV=production
EXPOSE 8080
USER node
CMD ["node", "server.js"]
