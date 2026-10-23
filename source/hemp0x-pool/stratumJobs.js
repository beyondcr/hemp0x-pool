let lastJobId = 0;

function nextJobId() {
  if (lastJobId >= Number.MAX_SAFE_INTEGER) {
    throw new Error('Stratum job ID space exhausted');
  }
  lastJobId += 1;
  return String(lastJobId);
}

function rememberJob(socket, job, clean) {
  if (!socket.recentJobs || clean) socket.recentJobs = new Map();
  socket.recentJobs.set(String(job.jobId), job);
  while (socket.recentJobs.size > 8) {
    socket.recentJobs.delete(socket.recentJobs.keys().next().value);
  }
  socket.currentJob = job;
}

module.exports = { nextJobId, rememberJob };
