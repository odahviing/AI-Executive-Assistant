FROM node:20-alpine

WORKDIR /app

# Install dependencies first (layer caching)
COPY package*.json ./
RUN npm ci --only=production

# Copy built output
COPY dist/ ./dist/

# SQLite data volume
VOLUME ["/app/data"]

# Non-root user for security
RUN addgroup -S maelle && adduser -S maelle -G maelle
RUN chown -R maelle:maelle /app
USER maelle

CMD ["node", "dist/index.js"]
