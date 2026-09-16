FROM node:20-alpine
RUN apk add --no-cache ffmpeg
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev
COPY . .
RUN mkdir -p /app/data/audio && chown -R node:node /app
ENV NODE_ENV=production PORT=3000 RADIO_DATA_DIR=/app/data
EXPOSE 3000
USER node
CMD ["node", "server.js"]
