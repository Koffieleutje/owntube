/**
 * Release signing from a keystore kept outside the repo.
 *
 * Expo's generated android/app/build.gradle signs release builds with the
 * debug key. When OWNTUBE_TV_KEYSTORE points at a keystore at prebuild time,
 * this adds a `release` signing config that reads it (path, passwords, alias
 * from the environment at build time, never written into the project) and
 * uses it for the release build type. Without the variable, nothing changes.
 *
 *   OWNTUBE_TV_KEYSTORE=/secure/owntube-tv.jks
 *   OWNTUBE_TV_KEYSTORE_PASSWORD=…  OWNTUBE_TV_KEY_ALIAS=owntube-tv
 *   OWNTUBE_TV_KEY_PASSWORD=…       (defaults to the keystore password)
 *
 * Note: a device with a debug-signed build installed must uninstall it before
 * installing a release-signed one (Android refuses a signature change).
 */
const {
  withAppBuildGradle,
  createRunOncePlugin,
} = require("expo/config-plugins");

const MARKER = "// owntube: release signing";

const SIGNING_CONFIG = `
        ${MARKER}
        release {
            storeFile file(System.getenv("OWNTUBE_TV_KEYSTORE"))
            storePassword System.getenv("OWNTUBE_TV_KEYSTORE_PASSWORD")
            keyAlias System.getenv("OWNTUBE_TV_KEY_ALIAS") ?: "owntube-tv"
            keyPassword System.getenv("OWNTUBE_TV_KEY_PASSWORD") ?: System.getenv("OWNTUBE_TV_KEYSTORE_PASSWORD")
        }`;

function withReleaseSigning(config) {
  if (!process.env.OWNTUBE_TV_KEYSTORE) return config;
  return withAppBuildGradle(config, (mod) => {
    let gradle = mod.modResults.contents;
    if (gradle.includes(MARKER)) return mod;
    // Add the config next to the generated debug one…
    gradle = gradle.replace(
      /signingConfigs\s*\{/,
      (match) => `${match}${SIGNING_CONFIG}`,
    );
    // …and point the release build type at it instead of the debug key.
    gradle = gradle.replace(
      /(buildTypes\s*\{[\s\S]*?release\s*\{[\s\S]*?)signingConfig\s+signingConfigs\.debug/,
      "$1signingConfig signingConfigs.release",
    );
    mod.modResults.contents = gradle;
    return mod;
  });
}

module.exports = createRunOncePlugin(
  withReleaseSigning,
  "with-release-signing",
  "1.0.0",
);
