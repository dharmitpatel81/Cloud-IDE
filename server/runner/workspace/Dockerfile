# The terminal's shell environment: one workspace image with both runtimes,
# because a shell session is where you switch between them freely — unlike a
# one-shot run, which gets the single-language image for its file.
# Same rules as the run images: pinned by digest, non-root, nothing extra.
# npm stays (it's how you `npm init` / `npm run`); with no network it still
# can't install anything, and that's the point until a later phase. (node:24-slim)
FROM node@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553

RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 \
    && rm -rf /var/lib/apt/lists/*

# The base image ships a non-root "node" user (uid 1000).
USER node
ENV TERM=xterm-256color
WORKDIR /workspace
