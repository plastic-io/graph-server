#!/bin/sh
# Rebuild the layer contents.  Run from this directory.
#
# Chromium does not fit in a function's zip, and webpack has nothing useful to
# do with a 50MB binary, so it rides in a layer the way isolated-vm does.
# Unlike isolated-vm there is nothing to compile: @sparticuz/chromium ships the
# browser as a brotli pack and playwright-core is plain JavaScript, so a plain
# install is the whole build and no Docker is needed.
set -e
cd nodejs
npm ci --omit=dev --no-audit --no-fund
cd ..
echo "layer contents:"
du -sh nodejs/node_modules
du -sh nodejs/node_modules/@sparticuz/chromium nodejs/node_modules/playwright-core 2>/dev/null || true
