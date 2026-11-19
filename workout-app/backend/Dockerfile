# FitLibrary API: one small container, no npm install needed (no dependencies).
FROM node:22-slim
WORKDIR /app
COPY package.json ./
COPY server ./server
# The database and pictures live on a mounted disk at /data so they survive restarts and deploys.
ENV NODE_ENV=production \
    PORT=8080 \
    DB_PATH=/data/fitlibrary.db \
    UPLOAD_DIR=/data/uploads \
    TRUST_PROXY=true
EXPOSE 8080
CMD ["node", "--disable-warning=ExperimentalWarning", "server/start.js"]
