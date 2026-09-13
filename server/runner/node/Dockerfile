# Runs untrusted JavaScript. Same rules as the Python image: pinned by
# digest, non-root, nothing extra. (node:24-slim)
FROM node@sha256:2fe369e969550cde8e867afc3fe370b260140cab4a23d467074295b42163d553

# Package managers are tools user code could run, and with no network they
# can't install anything anyway. Removed while we're still root.
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack \
    /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
    /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg

# The base image ships a non-root "node" user (uid 1000).
USER node

WORKDIR /home/node
