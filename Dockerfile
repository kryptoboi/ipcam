FROM node:20-alpine

WORKDIR /app

# Skopiuj package.json i zainstaluj zależności
COPY server/package*.json ./server/
RUN cd server && npm ci --only=production

# Skopiuj cały projekt
COPY server/ ./server/
COPY camera-client/ ./camera-client/
COPY receiver-client/ ./receiver-client/

# Utwórz katalogi na nagrania
RUN mkdir -p /app/recordings/clips /app/recordings/full

# Wolumen na nagrania (opcjonalny – Cloud Run efemeryczny dysk)
VOLUME ["/app/recordings"]

WORKDIR /app/server

# Google Cloud Run używa zmiennej PORT
ENV PORT=8080
ENV RECORDINGS_DIR=/app/recordings
ENV NODE_ENV=production

EXPOSE 8080

# Healthcheck
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD wget -qO- http://localhost:8080/api/status || exit 1

CMD ["node", "server.js"]
