// Small process-wide queue for expensive scheduled cohort work. Separate
// Apps Script projects can run concurrently, but bounding the total avoids
// synchronized bursts against one Google account.

const pending = [];
let active = 0;
const MAX_ACTIVE = 2;

function drain() {
  while (active < MAX_ACTIVE && pending.length) {
    const item = pending.shift();
    active++;
    Promise.resolve()
      .then(item.task)
      .then(item.resolve, item.reject)
      .finally(() => {
        active--;
        drain();
      });
  }
}

function runQuotaTask(label, task) {
  return new Promise((resolve, reject) => {
    pending.push({ label, task, resolve, reject });
    drain();
  });
}

function queueStatus() {
  return { active, pending: pending.length, limit: MAX_ACTIVE };
}

module.exports = { queueStatus, runQuotaTask };
