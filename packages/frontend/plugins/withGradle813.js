/**
 * Expo config plugin to downgrade Gradle from 9.0.0 to 8.13.
 *
 * Gradle 9.0.0 has a known bug where the built-in Foojay JDK resolver
 * crashes with "JvmVendorSpec does not have member field IBM_SEMERU"
 * on systems with JDK 21. Gradle 8.13 is the latest 8.x that satisfies
 * the minimum AGP requirement and doesn't have this issue.
 *
 * This plugin runs during `expo prebuild` and patches the generated
 * gradle-wrapper.properties file.
 */

const { withGradleProperties } = require('expo/config-plugins');
const fs = require('fs');
const path = require('path');

function withGradle813(config) {
  return withGradleProperties(config, (config) => {
    const projectRoot = config.modRequest.projectRoot;
    const wrapperProps = path.join(
      projectRoot,
      'android',
      'gradle',
      'wrapper',
      'gradle-wrapper.properties',
    );

    if (fs.existsSync(wrapperProps)) {
      let content = fs.readFileSync(wrapperProps, 'utf-8');
      content = content.replace(
        /distributionUrl=.*gradle-[\d.]+-bin\.zip/,
        'distributionUrl=https\\://services.gradle.org/distributions/gradle-8.13-bin.zip',
      );
      fs.writeFileSync(wrapperProps, content, 'utf-8');
    }

    return config;
  });
}

module.exports = withGradle813;
