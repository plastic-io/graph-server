#!/bin/sh
# Rebuild the layer contents.  Run from this directory; needs Docker.
set -e
docker build --platform linux/amd64 --target export --output type=local,dest=. .
echo "layer contents:"
du -sh nodejs/node_modules/isolated-vm
# Only the two Lambda platforms are kept; the package ships prebuilds for both
# Node 22 ABIs, so the layer works on x86_64 and arm64 functions alike.
rm -rf nodejs/node_modules/isolated-vm/prebuilds/darwin-arm64 \
       nodejs/node_modules/isolated-vm/prebuilds/win32-x64 \
       nodejs/node_modules/isolated-vm/isolated-vm-6.2.0.tgz \
       nodejs/node_modules/isolated-vm/native-example \
       nodejs/node_modules/isolated-vm/inspector-example.js
