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
    squashfs-tools \
    squashfuse \
    fuse-overlayfs \
  && rm -rf /var/lib/apt/lists/*

# Pi SDK deps live OUTSIDE /workspace. A resume unsquashes a snapshot of /workspace
# over the live dir, which would clobber a baked-in /workspace/node_modules and break
# the runner's import. Installing under /opt/pi (with NODE_PATH set on the runner) keeps
# the snapshot small AND keeps the SDK resolvable after a restore.
WORKDIR /opt/pi

RUN npm init -y \
  && npm install --ignore-scripts @earendil-works/pi-coding-agent@0.80.2 typebox@1.1.38 \
  && pip3 install --no-cache-dir --break-system-packages \
    numpy==2.3.5 \
    pandas==2.3.3 \
    pydantic==2.12.3 \
    scipy==1.16.3 \
    scikit-learn==1.7.2

WORKDIR /workspace

# Untrusted, model-generated code (the Pi runner and /execute analysis) runs as
# this unprivileged user via setpriv, never as root. The /sandbox container server
# itself stays root (it manages the container); only the agent processes drop down.
# /workspace is chowned to traceflow at run start (writeFile/mkdir/unsquashfs run
# as root and would otherwise leave files the agent can't write).
RUN useradd --uid 10001 --create-home --home-dir /home/traceflow \
  --shell /usr/sbin/nologin traceflow \
  && chown traceflow:traceflow /workspace

ENTRYPOINT ["/sandbox"]
