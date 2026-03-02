# Update Poller Microservice

A NestJS service that polls Redis for live listening data and broadcasts top tracks via WebSockets.

## Setup

```bash
npm install
cp .env.example .env # Configure your Redis URI
```

## Run

```bash
# Development
npm run start:dev

# Docker
docker build -t update-poller .
docker-compose up -d
```

## Docker & CI

- **Docker**: Multi-stage build for production-ready images.
- **CI**: GitHub Actions workflow (`.github/workflows/ci.yml`) automatically lints, builds, and pushes the image to Docker Hub on every push to `main`.

## License
MIT
