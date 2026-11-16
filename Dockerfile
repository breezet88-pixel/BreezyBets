# ApexBets: one small container. No npm install is needed: the app has no dependencies.
FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY public ./public

# Defaults for a hosted site. The database lives on a mounted disk at /data so it survives restarts and deploys.
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/apexbets.db \
    TRUST_PROXY=1
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "server/server.js"]
