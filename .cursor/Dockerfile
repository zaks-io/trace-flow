FROM node:24-bookworm

RUN apt-get update \
  && apt-get install -y --no-install-recommends \
    ca-certificates \
    chromium \
    curl \
    git \
    jq \
    unzip \
  && rm -rf /var/lib/apt/lists/*

ENV BUN_INSTALL=/usr/local/share/bun
ENV CHROME_PATH=/usr/bin/chromium
ENV PATH=/usr/local/share/bun/bin:$PATH
WORKDIR /workspace

RUN curl -fsSL https://bun.sh/install | bash -s -- bun-v1.3.5 \
  && chown -R node:node /workspace /usr/local/share/bun

USER node
