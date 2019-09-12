const Promise = require('bluebird');

// aggregate error
class MultiLockError extends Promise.AggregateError {
  constructor(errors, locks) {
    super(errors);
    this.name = 'MultiLockError';
    this.locks = locks;
  }
}

exports.MultiLockError = MultiLockError;
