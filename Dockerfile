FROM node:18-alpine

WORKDIR /app

# Install dependencies
COPY package*.json ./
RUN npm ci --omit=dev

# Build frontend
COPY trader-ui/package*.json trader-ui/
RUN cd trader-ui && npm ci
COPY trader-ui/ trader-ui/
RUN cd trader-ui && npm run build

# Copy backend
COPY src/ src/
COPY db/ db/

EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://localhost:3001/api/status || exit 1

CMD ["node", "src/index.js"]
