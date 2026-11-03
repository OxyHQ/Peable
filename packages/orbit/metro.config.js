const { createOxyMetroConfig } = require('@oxy.so/app-preset/metro');
module.exports = createOxyMetroConfig(__dirname, { sharedTypesPackage: '@peable.to/shared-types' });
