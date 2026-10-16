#!/bin/sh
# Rebuild the layer contents.  Run from this directory; needs Docker.
set -e
docker build --platform linux/amd64 --target export --output type=local,dest=. .
echo "layer contents:"
du -sh nodejs/node_modules/isolated-vm
# The platform is pinned to Linux x86_64 / Node 22 (ABI 127), verified in the
# Lambda image. Other shipped prebuilds are not evidence of runtime support.
rm -rf nodejs/node_modules/isolated-vm/prebuilds/darwin-arm64 \
       nodejs/node_modules/isolated-vm/prebuilds/win32-x64 \
       nodejs/node_modules/isolated-vm/isolated-vm-6.2.0.tgz \
       nodejs/node_modules/isolated-vm/native-example \
       nodejs/node_modules/isolated-vm/inspector-example.js
