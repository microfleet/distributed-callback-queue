const uid = process.getuid();

module.exports = exports = {
  node: "20",
  nycCoverage: false,
  test_framework: "jest --coverage --coverageDirectory <coverageDirectory> --runTestsByPath --colors",
  tests: "__tests__/*.spec.ts",
  auto_compose: true,
  services: [],
  in_one: true,
  extras: {
    tester: {
      user: `${uid}:${uid}`,
      environment: {
        DB: '${DB}'
      }
    }
  }
}

switch (process.env.DB) {
  case 'cluster':
    exports.services.push('redisCluster');
    break;
  case 'sentinel':
  default:
    exports.services.push('redisSentinel');
    break;
}
