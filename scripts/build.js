/* Copyright (c) 2021 Nordic Semiconductor ASA
 *
 * SPDX-License-Identifier: LicenseRef-Nordic-1-Clause
 */

const esbuild = require("esbuild");
const path = require("path");
const fs = require("fs-extra");
const yargs = require("yargs/yargs");
const { hideBin } = require("yargs/helpers");

const base = path.join(__dirname, "../");
const outputDir = "dist";

const y = yargs(hideBin(process.argv)).options({
  watch: {
    describe: "Watches extension files and rebuilds on change.",
    type: "boolean",
  },
  production: {
    describe: "Enables production optimisations.",
    type: "boolean",
  },
}).argv;

/** @type esbuild.BuildOptions */
const common = {
  bundle: true,
  minify: y.production,
  watch: y.watch && {
    onRebuild(error) {
      if (!error) {
        console.log("[watch] extension rebuilt");
      }
    },
  },
  format: "cjs",
  target: "es6",
  sourcemap: y.production ? undefined : "inline",
};

function buildMainExtension() {
  console.log("Building main extension...");

  return esbuild.build({
    ...common,
    platform: "node",
    external: ["vscode"],
    entryPoints: [path.join(base, "src", "extension.ts")],
    outfile: path.join(base, outputDir, "extension.js"),
  });
}

function buildWebviews() {
  console.log("Building webviews...");

  const webviewBase = path.join(base, "src", "webview", "pages");

  return esbuild.build({
    ...common,
    platform: "browser",
    entryPoints: {},
    outdir: path.join(base, outputDir, "webview"),
  });
}

async function copyAssets() {
  console.log("Copying assets...");

  // These paths assume the script is being run from the root directory.
  const copyPatterns = [
    {
      from: "./src/webview/pages/styles.css",
      to: `./${outputDir}/webview/styles.css`,
    },
    {
      from: "./src/webview/pages/webview.html",
      to: `./${outputDir}/webview/webview.html`,
    },
    {
      from: "./node_modules/@vscode/codicons/dist/codicon.css",
      to: `./${outputDir}/webview/codicon.css`,
    },
    {
      from: "./node_modules/@vscode/codicons/dist/codicon.ttf",
      to: `./${outputDir}/webview/codicon.ttf`,
    },
  ];

  await Promise.all(copyPatterns.map((f) => fs.copy(f.from, f.to)));
}

async function build() {
  if (y.production) {
    console.log("Packaging for production.");
  }
  if (y.watch) {
    console.log("[watch] build started");
  }
  await buildMainExtension();
  await buildWebviews();
  await copyAssets();
  if (y.watch) {
    console.log("[watch] build finished");
  } else {
    console.log("Done.");
  }
}

build();
