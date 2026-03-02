# Build stage
FROM node:22-alpine AS builder

WORKDIR /usr/src/app

COPY package*.json ./

RUN npm ci

COPY . .

RUN npm run build

# Production stage
FROM node:22-alpine AS production

WORKDIR /usr/src/app

# Copy package.json and package-lock.json
COPY package*.json ./

# Install only production dependencies
RUN npm ci --omit=dev

# Copy built artifacts from the builder stage
COPY --from=builder /usr/src/app/dist ./dist

# The PORT environment variable should be exposed
EXPOSE 8081

# Command to run the application
CMD ["node", "dist/main"]
