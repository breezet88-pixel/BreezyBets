# FitLibrary website: static files plus a tiny server. No npm install needed.
FROM node:22-slim
WORKDIR /app
COPY package.json serve.js ./
COPY public ./public
ENV PORT=8080
EXPOSE 8080
CMD ["node", "serve.js"]
