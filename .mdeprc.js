module.exports = {
  "node": "14",
  "nycCoverage": false,
  "test_framework": "jest --coverage --coverageDirectory <coverageDirectory>",
  "tests": "__tests__/*.js",
  "docker_compose": "__tests__/docker-compose.yml",
  "auto_compose": true,
  "services": [
    "redisSentinel"
  ]
}
