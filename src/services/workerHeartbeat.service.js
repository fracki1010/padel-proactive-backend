const os = require("node:os");
const WorkerHeartbeat = require("../models/workerHeartbeat.model");

const DEFAULT_SERVICE_NAME = "whatsapp-worker";
const DEFAULT_STALE_MS = Number(
  process.env.WORKER_HEARTBEAT_STALE_MS || 30_000,
);

const resolveServiceName = (serviceName = DEFAULT_SERVICE_NAME) =>
  String(serviceName || DEFAULT_SERVICE_NAME).trim().toLowerCase();

const buildWorkerId = () => {
  const host = os.hostname() || "unknown-host";
  return `${host}:${process.pid}`;
};

const sendWorkerHeartbeat = async ({
  serviceName = DEFAULT_SERVICE_NAME,
  workerId = null,
} = {}) => {
  const normalizedServiceName = resolveServiceName(serviceName);
  const normalizedWorkerId =
    typeof workerId === "string" && workerId.trim()
      ? workerId.trim()
      : buildWorkerId();

  await WorkerHeartbeat.findOneAndUpdate(
    { serviceName: normalizedServiceName },
    {
      $set: {
        serviceName: normalizedServiceName,
        workerId: normalizedWorkerId,
        host: os.hostname() || null,
        pid: process.pid,
        heartbeatAt: new Date(),
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true },
  );
};

const getWorkerHealth = async ({
  serviceName = DEFAULT_SERVICE_NAME,
  staleMs = DEFAULT_STALE_MS,
} = {}) => {
  const normalizedServiceName = resolveServiceName(serviceName);
  const staleThresholdMs =
    Number.isFinite(Number(staleMs)) && Number(staleMs) > 0
      ? Number(staleMs)
      : DEFAULT_STALE_MS;

  const doc = await WorkerHeartbeat.findOne({
    serviceName: normalizedServiceName,
  }).lean();

  const heartbeatAt = doc?.heartbeatAt instanceof Date ? doc.heartbeatAt : null;
  const ageMs = heartbeatAt ? Date.now() - heartbeatAt.getTime() : Number.POSITIVE_INFINITY;

  return {
    serviceName: normalizedServiceName,
    online: ageMs <= staleThresholdMs,
    heartbeatAt: heartbeatAt ? heartbeatAt.toISOString() : null,
    workerId: typeof doc?.workerId === "string" ? doc.workerId : null,
    staleAfterMs: staleThresholdMs,
  };
};

module.exports = {
  DEFAULT_SERVICE_NAME,
  sendWorkerHeartbeat,
  getWorkerHealth,
};
