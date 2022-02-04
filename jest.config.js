exports.testEnvironment = 'node'
exports.verbose = true
exports.coverageProvider = 'v8'
exports.transform = {
  '^.+\\.(t|j)sx?$': ['@swc-node/jest'],
}
