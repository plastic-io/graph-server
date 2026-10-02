const path = require('path');
const slsw = require('serverless-webpack');

module.exports = {
  entry: slsw.lib.entries,
  resolve: {
    // The shared CRDT package is linked in from the editor repository.  Keeping
    // symlinks unresolved makes it resolve as node_modules/@plastic-io/graph-crdt,
    // so its `yjs` import binds to this project's copy.  Following the symlink
    // would pull in the editor's copy as well and two Yjs instances in one
    // bundle break every instanceof check the codec relies on.
    symlinks: false,
    extensions: [
      '.js',
      '.jsx',
      '.json',
      '.ts',
      '.tsx'
    ]
  },
  output: {
    libraryTarget: 'commonjs',
    path: path.join(__dirname, '.webpack'),
    filename: '[name].js',
  },
  target: 'node',
  // The isolated-vm addon is a .node binary shipped as a Lambda layer; it is
  // required at runtime (src/runtime/isolate.ts) and must never be bundled.
  externals: {
    'isolated-vm': 'commonjs isolated-vm',
    // chromium and its driver ride in a layer; bundling a 50MB browser would
    // be absurd and webpack cannot do anything useful with it anyway
    '@sparticuz/chromium': 'commonjs @sparticuz/chromium',
    'playwright-core': 'commonjs playwright-core',
  },
  module: {
    rules: [
      {
        test: /\.ts(x?)$/,
        loader: 'ts-loader',
      },
    ],
  },
};
