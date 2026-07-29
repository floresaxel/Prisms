/* eslint-disable */
/**
 * Autolinking overrides.
 *
 * `expo`'s own `android/build.gradle` declares `namespace "expo.core"`, but its
 * package class actually lives in `expo.modules`
 * (`android/src/main/java/expo/modules/ExpoModulesPackage.kt`). Autolinking
 * derives `packageImportPath` from the namespace when the dependency's own
 * `react-native.config.js` is not applied, and then the generated
 * `PackageList.java` fails to compile:
 *
 *     PackageList.java:16: error: cannot find symbol
 *       import expo.core.ExpoModulesPackage;
 *
 * Stating it here is the supported project-level override and is platform
 * independent, so it fixes the build on Windows and in WSL alike.
 */
module.exports = {
  dependencies: {
    expo: {
      platforms: {
        android: {
          packageImportPath: 'import expo.modules.ExpoModulesPackage;',
          packageInstance: 'new ExpoModulesPackage()',
        },
      },
    },
  },
};
