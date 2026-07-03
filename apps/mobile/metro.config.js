/* eslint-disable */
// Metro bundler config for the Prisms Expo app inside a pnpm monorepo.
//
// Extends Expo SDK 53's default config (which already enables workspace symlink
// resolution) with two monorepo concerns:
//   1. watch the whole workspace so the shared @prisms/ui + @prisms/core sources
//      are bundled from packages/*, and
//   2. S9-F3: force a SINGLE React (and the React Native it is version-locked to).
//      React Native 0.79's renderer is paired with Expo 53's React 19.0.0. The
//      shared @prisms/ui workspace package carries its OWN React (19.2.x, an
//      auto-installed peer) in packages/ui/node_modules; when Metro resolves
//      `react` from inside ui's files it would otherwise pick up that duplicate,
//      which crashes hooks at runtime (the unsupported pairing S9-F3 fixes). We
//      redirect every `react`/`react-native` request to THIS app's copy (19.0.0).
//
// NOTE: this file is only exercised by a real Metro bundle (device/emulator) — it
// is NOT covered by the JS gate (lint/typecheck/vitest). Verify with a dev build.
const { getDefaultConfig } = require('expo/metro-config');
const path = require('path');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

const forcedSingletons = ['react', 'react-native'];
const originFromApp = path.join(projectRoot, 'index.ts');
const defaultResolveRequest = config.resolver.resolveRequest;
config.resolver.resolveRequest = (context, moduleName, platform) => {
  const isSingleton = forcedSingletons.some(
    (name) => moduleName === name || moduleName.startsWith(`${name}/`),
  );
  // Resolve react/react-native AS IF imported from the app root, so the app's
  // node_modules (Expo 53's 19.0.0) wins over any nested workspace copy.
  const resolver = defaultResolveRequest ?? context.resolveRequest;
  return resolver(
    isSingleton ? { ...context, originModulePath: originFromApp } : context,
    moduleName,
    platform,
  );
};

module.exports = config;
