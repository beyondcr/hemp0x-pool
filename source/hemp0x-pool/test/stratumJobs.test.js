const { test } = require('node:test');
const assert = require('node:assert/strict');
const { nextJobId, rememberJob } = require('../stratumJobs');

test('retargeting within the same template preserves both header/target pairs', () => {
  const socket = {};
  const oldJob = { jobId: nextJobId(), height: 100, headerHash: 'old', target: 'easy' };
  const retargetedJob = { jobId: nextJobId(), height: 100, headerHash: 'new', target: 'hard' };
  rememberJob(socket, oldJob, true);
  rememberJob(socket, retargetedJob, false);
  assert.notEqual(oldJob.jobId, retargetedJob.jobId);
  assert.strictEqual(socket.recentJobs.get(oldJob.jobId), oldJob);
  assert.strictEqual(socket.recentJobs.get(retargetedJob.jobId), retargetedJob);
  assert.strictEqual(socket.currentJob, retargetedJob);
});

test('a clean job invalidates all work on the previous tip', () => {
  const socket = {};
  const oldJob = { jobId: nextJobId(), height: 100 };
  const newJob = { jobId: nextJobId(), height: 101 };
  rememberJob(socket, oldJob, false);
  rememberJob(socket, newJob, true);
  assert.equal(socket.recentJobs.has(oldJob.jobId), false);
  assert.strictEqual(socket.recentJobs.get(newJob.jobId), newJob);
});

test('job retention stays bounded and IDs do not repeat across connections', () => {
  const a = {};
  const b = {};
  const ids = new Set();
  for (let index = 0; index < 10020; index += 1) {
    const job = { jobId: nextJobId() };
    assert.equal(ids.has(job.jobId), false);
    ids.add(job.jobId);
    rememberJob(index % 2 ? a : b, job, false);
  }
  assert.equal(a.recentJobs.size, 8);
  assert.equal(b.recentJobs.size, 8);
});
