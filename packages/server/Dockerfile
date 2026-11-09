# mem-mem server image: a thin wrapper around the memmem-server package.
# It installs Letta Code (from npm, Letta's own channel) and the memmem-server
# release tarball (`npm run pack:release`, the same file that is attached to
# the GitHub Release), then runs `memmem-server start`.
# Published as ghcr.io/<owner>/mem-mem-server:<version> by .github/workflows/release.yml.
#
# Build from the repo root:
#   docker build -t mem-mem:dev -f packages/server/Dockerfile .
# With an already packed tarball (what the release workflow does), replace the
# `pack` stage with a directory that holds out/memmem-server-<version>.tgz:
#   docker buildx build --build-context pack=<dir> -t mem-mem:dev -f packages/server/Dockerfile .

# --- pack memmem-server from the workspace (scripts/pack.mjs) ----------------
# The tarball is platform-independent, so this stage runs on the build host's
# platform even when the image is built for another architecture.
FROM --platform=$BUILDPLATFORM node:24.22-bookworm AS pack
WORKDIR /src
COPY package.json package-lock.json .npmrc ./
COPY client/package.json client/package.json
COPY packages/server/package.json packages/server/package.json
RUN npm ci --no-audit --no-fund --workspace memmem-server --include-workspace-root=false
COPY LICENSE ./
COPY templates/ templates/
COPY packages/server/ packages/server/
# The publishable tarball: dist/, templates/ and the bundled runtime dependencies.
RUN node packages/server/scripts/pack.mjs /out

# --- runtime ----------------------------------------------------------------
FROM node:24.22-bookworm

# Keep in sync with LETTA_CODE_VERSION in scripts/install-server.sh.
ARG LETTA_CODE_VERSION=0.34.41

# git: MemFS and memory/transcripts repos. zstd: Codex .zst sessions.
# python3/make/g++: node-pty native build. jq: handy for operators. gh: repo
# creation and git auth. python-is-python3: the reflection subagent often runs
# `python` first. tini: PID 1 that reaps zombies and forwards signals.
RUN apt-get update \
 && apt-get install -y --no-install-recommends git zstd python3 python-is-python3 make g++ jq gh ca-certificates curl tini \
 && rm -rf /var/lib/apt/lists/*

# npm 11 blocks install scripts by default; letta-code needs its postinstall and node-pty's native build.
RUN npm i -g --allow-scripts=@letta-ai/letta-code,node-pty,sharp,protobufjs,@scarf/scarf,@google/genai \
      "@letta-ai/letta-code@${LETTA_CODE_VERSION}" \
 && test -f "$(npm root -g)/@letta-ai/letta-code/node_modules/node-pty/build/Release/pty.node" \
 && letta --version \
 && npm cache clean --force

# The tarball bundles its dependencies, so the Agent SDK's peer (Letta Code,
# installed above) is not pulled in a second time.
COPY --from=pack /out/ /tmp/pkg/
RUN npm i -g /tmp/pkg/memmem-server-*.tgz \
 && rm -rf /tmp/pkg \
 && memmem-server version \
 && npm cache clean --force

# Server data root (projects.json, worker state, clones, logs, gitconfig).
# LETTA_CONFIG_DIR stays /root/.letta so existing volumes keep working; without
# it memmem-server would use $MEMMEM_SERVER_HOME/letta.
ENV MEMMEM_SERVER_HOME=/var/lib/mem-mem \
    LETTA_CONFIG_DIR=/root/.letta \
    LETTA_APP_SERVER_PORT=4500
VOLUME ["/root/.letta", "/var/lib/mem-mem"]
WORKDIR /var/lib/mem-mem

# The App Server listens on loopback only; nothing is exposed by default.
ENTRYPOINT ["/usr/bin/tini", "--", "memmem-server", "start"]
