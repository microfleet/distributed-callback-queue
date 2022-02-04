const uid = process.getuid();

module.exports = exports = {
  node: "16",
  nycCoverage: false,
  test_framework: "jest --coverage --coverageDirectory <coverageDirectory> --runTestsByPath --colors",
  tests: "__tests__/*.spec.ts",
  docker_compose: "__tests__/docker-compose.yml",
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
