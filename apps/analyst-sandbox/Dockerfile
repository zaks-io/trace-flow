FROM docker.io/cloudflare/sandbox:0.12.1 AS sandbox

FROM node:24-bookworm-slim

COPY --from=sandbox /container-server/sandbox /sandbox

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    curl \
    git \
    jq \
    python3 \
    python3-pip \
    ripgrep \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /workspace

RUN npm init -y \
  && npm install --ignore-scripts @earendil-works/pi-coding-agent@0.80.2 typebox@1.1.38 \
  && pip3 install --no-cache-dir --break-system-packages \
    numpy==2.3.5 \
    pandas==2.3.3 \
    scipy==1.16.3 \
    scikit-learn==1.7.2

ENTRYPOINT ["/sandbox"]
