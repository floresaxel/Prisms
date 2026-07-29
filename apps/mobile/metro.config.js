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
//   3. …and `@powersync/react` for the SAME reason, one level up. Because ui and
//      the app resolve different Reacts, pnpm gives them different *instances* of
//      @powersync/react (the peer hash differs: react@19.0.0 vs react@19.2.7).
//      Two instances means two distinct `PowerSyncContext` objects, so App.tsx's
//      provider populates one while PrismsDataProvider reads the other and gets
//      null — surfacing on the first authed render as
//      "Cannot read property 'currentStatus' of null" inside useStatus.
//      Only packages declared in THIS app's package.json can be forced this way,
//      since resolution is re-rooted at the app; @powersync/common is not, and
//      follows the singleton react/@powersync/react anyway.
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

const forcedSingletons = ['react', 'react-native', '@powersync/react'];
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
