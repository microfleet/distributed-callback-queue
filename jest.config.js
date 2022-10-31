exports.testEnvironment = 'node'
exports.verbose = true
exports.coverageProvider = 'v8'
exports.transform = {
  '^.+\\.(t|j)s$': ['@swc-node/jest'],
}
