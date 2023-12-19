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
      },
    }
  }
}

switch (process.env.DB) {
  case 'cluster':
    exports.services.push('redisCluster');

    exports.extras['redis-cluster'] = {
      healthcheck: {
        test: "redis-cli -p 7000 cluster info | grep cluster_state:ok > /dev/null && exit 0 || exit 1",
        interval: '1s',
        timeout: '5s',
        retries: 30,
      }
    }

    break;
  case 'sentinel':
  default:
    exports.services.push('redisSentinel');
    break;
}
