//@ts-check
'use strict';

const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');

/** @type {import('webpack').Configuration} */
const config = {
  target: 'node',
  mode: 'none',
  entry: './src/extension.ts',
  output: {
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2'
  },
  externals: {
    // VS Code runtime provides this
    vscode: 'commonjs vscode',
    // sql.js is a pure JS + WASM module; keep it external to avoid bundling
    // its emscripten loader. It has NO native binary, so it stays portable.
    'sql.js': 'commonjs sql.js'
  },
  resolve: {
    extensions: ['.ts', '.js']
  },
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: /node_modules/,
        use: [{ loader: 'ts-loader' }]
      }
    ]
  },
  plugins: [
    new CopyPlugin({
      patterns: [
        // tree-sitter wasm runtime + C grammar
        {
          from: 'node_modules/web-tree-sitter/tree-sitter.wasm',
          to: 'tree-sitter.wasm',
          noErrorOnMissing: true
        },
        // sql.js wasm (store.ts resolves it next to extension.js in dist/)
        {
          from: 'node_modules/sql.js/dist/sql-wasm.wasm',
          to: 'sql-wasm.wasm',
          noErrorOnMissing: true
        },
        { from: 'wasm', to: 'wasm' },
        // webview assets
        { from: 'src/webview', to: 'webview' }
      ]
    })
  ],
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: 'log'
  }
};

module.exports = config;
