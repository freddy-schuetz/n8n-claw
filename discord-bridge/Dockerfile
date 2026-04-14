FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY bot.js .
EXPOSE 3300
CMD ["node", "bot.js"]
