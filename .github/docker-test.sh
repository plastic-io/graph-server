#!/bin/sh
# Runs the server suite inside the Lambda Node 22 image, where the isolate
# addon has to work (plan §8.1.4).  Used by continuous integration and runnable
# by hand: sh .github/docker-test.sh
set -e
cd "$(dirname "$0")/.."
SERVER=$(pwd)
EDITOR_REPO=${EDITOR_REPO:-$SERVER/../graph-editor}
if [ ! -d "$EDITOR_REPO" ]; then
  echo "The shared CRDT package is linked from $EDITOR_REPO, which is not there." >&2
  exit 1
fi
docker run --rm \
  -v "$SERVER":/work/graph-server \
  -v "$(cd "$EDITOR_REPO" && pwd)":/work/graph-editor \
  -w /work/graph-server \
  --entrypoint /bin/sh \
  public.ecr.aws/lambda/nodejs:22 -c '
    set -e
    cp -r /work/graph-server /tmp/graph-server
    mkdir -p /tmp/graph-editor/packages
    cp -r /work/graph-editor/packages/GraphCrdt /tmp/graph-editor/packages/GraphCrdt
    cd /tmp/graph-server
    rm -rf node_modules
    npm ci --no-audit --no-fund
    npx jest --ci
  '
