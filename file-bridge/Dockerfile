FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY server.js .
RUN mkdir -p /data/files /data/meta
EXPOSE 3200
CMD ["node", "server.js"]
