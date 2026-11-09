# One image for the whole stack: the app, and the scripts that fetch RustFS, Orthanc and the sample data
# onto the pod's volume. deploy/k8s runs each as its own container.
FROM oven/bun:1.4.3-debian
RUN apt-get update -q && apt-get install -y -q --no-install-recommends dcmtk curl unzip ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json bun.lock ./
COPY packages/core/package.json packages/core/
RUN bun install --frozen-lockfile --production
COPY . .
ENV DEMO_STORAGE=/data SOURCES_DIR=/data/sources DEMO_TAILNET=0
EXPOSE 4605
USER bun
CMD ["bun", "src/main.ts"]
