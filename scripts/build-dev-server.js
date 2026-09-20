/**
 * Bundles the local dev server.  It shares the Lambda webpack config so that
 * the code being exercised is the code that gets deployed.
 */
const path = require('path');
const webpack = require('webpack');
const base = require('../webpack.config.js');
const root = path.join(__dirname, '..');

webpack({
  ...base,
  mode: 'development',
  devtool: false,
  context: root,
  entry: { devServer: path.join(root, 'src/devServer.ts') },
  externals: { ws: 'commonjs ws', 'aws-sdk': 'commonjs aws-sdk' },
  output: { ...base.output, path: path.join(root, '.devserver') },
  module: {
    rules: [
      {
        test: /\.ts(x?)$/,
        loader: 'ts-loader',
        options: { transpileOnly: true, configFile: path.join(root, 'tsconfig.json') },
      },
    ],
  },
}, (err, stats) => {
  if (err) {
    console.error(err);
    process.exit(1);
  }
  if (stats.hasErrors()) {
    console.error(stats.toJson({ errors: true }).errors.slice(0, 5).map((e) => e.message || e).join('\n\n'));
    process.exit(1);
  }
  console.log('dev server bundled');
});
