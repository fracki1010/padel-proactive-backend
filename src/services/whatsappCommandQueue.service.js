const os = require("node:os");
const WhatsappCommand = require("../models/whatsappCommand.model");
const { setWhatsappEnabled } = require("./whatsappControl.service");
const { getReadyClient, restartClient } = require("./whatsappTenantManager.service");
const {
  listWhatsappGroups,
  notifyCancellationToGroup,
} = require("./whatsappCancellationGroup.service");
const { saveWhatsappGroupsSnapshot } = require("./whatsappGroupsSnapshot.service");

const COMMAND_TYPES = {
  SET_ENABLED: "set_enabled",
  SEND_MESSAGE: "send_message",
  RESTART_CLIENT: "restart_client",
  LIST_GROUPS: "list_groups",
  NOTIFY_CANCELLATION_GROUP: "notify_cancellation_group",
};

const COMMAND_STATUSES = {
  QUEUED: "queued",
  PROCESSING: "processing",
  DONE: "done",
  FAILED: "failed",
};

const QUEUE_DRIVERS = {
  MONGO: "mongo",
  REDIS: "redis",
};

const queueDriver = String(process.env.WHATSAPP_QUEUE_DRIVER || QUEUE_DRIVERS.MONGO)
  .trim()
  .toLowerCase();

const DEFAULT_POLL_INTERVAL_MS = Number(
  process.env.WHATSAPP_COMMAND_POLL_INTERVAL_MS || 2000,
);
const DEFAULT_MAX_ATTEMPTS = Number(
  process.env.WHATSAPP_COMMAND_MAX_ATTEMPTS || 3,
);

let monitorTimer = null;
let monitorRunning = false;
let redisQueueInstance = null;

const normalizeCompanyId = (companyId = null) => companyId || null;

const normalizeWorkerId = () => {
  const host = os.hostname() || "unknown-host";
  return `wa-cmd-worker:${host}:${process.pid}`;
};

const getRedisQueue = () => {
  if (redisQueueInstance) return redisQueueInstance;

  let Queue;
  let IORedis;

  try {
    ({ Queue } = require("bullmq"));
    IORedis = require("ioredis");
  } catch (error) {
    throw new Error(
      `WHATSAPP_QUEUE_DRIVER=redis requiere instalar dependencias bullmq/ioredis: ${error?.message || error}`,
    );
  }

  const redisConnection = new IORedis({
    host: String(process.env.REDIS_HOST || "127.0.0.1").trim(),
    port: Number(process.env.REDIS_PORT || 6379),
    db: Number(process.env.REDIS_DB || 0),
    ...(String(process.env.REDIS_PASSWORD || "").trim()
      ? { password: String(process.env.REDIS_PASSWORD || "").trim() }
      : {}),
    ...(String(process.env.REDIS_TLS || "false").trim() === "true" ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  });

  const queueName = String(process.env.WHATSAPP_QUEUE_NAME || "whatsapp-commands").trim();
  redisQueueInstance = new Queue(queueName, { connection: redisConnection });
  return redisQueueInstance;
};

const createCommandRecord = async ({ companyId, type, payload, requestedBy }) =>
  WhatsappCommand.create({
    companyId,
    type,
    payload,
    status: COMMAND_STATUSES.QUEUED,
    attempts: 0,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    requestedBy,
  });

const enqueueRedisJob = async (command) => {
  const queue = getRedisQueue();

  await queue.add(
    "whatsapp-command",
    {
      commandId: String(command._id),
      companyId: command.companyId ? String(command.companyId) : null,
      type: command.type,
      payload: command.payload,
    },
    {
      jobId: String(command._id),
      attempts: Number(command.maxAttempts || DEFAULT_MAX_ATTEMPTS),
      backoff: { type: "exponential", delay: 2000 },
      removeOnComplete: true,
      removeOnFail: false,
    },
  );
};

const enqueueWhatsappCommand = async ({
  companyId = null,
  type,
  payload = {},
  requestedBy = null,
}) => {
  const normalizedCompanyId = normalizeCompanyId(companyId);
  const normalizedType = String(type || "").trim();
  if (!normalizedType) {
    throw new Error("Tipo de comando de WhatsApp inválido.");
  }

  if (
    normalizedType === COMMAND_TYPES.SET_ENABLED ||
    normalizedType === COMMAND_TYPES.RESTART_CLIENT ||
    normalizedType === COMMAND_TYPES.LIST_GROUPS
  ) {
    const dedupeFilter = {
      companyId: normalizedCompanyId,
      type: normalizedType,
      status: { $in: [COMMAND_STATUSES.QUEUED, COMMAND_STATUSES.PROCESSING] },
    };

    if (normalizedType === COMMAND_TYPES.SET_ENABLED) {
      dedupeFilter["payload.enabled"] = Boolean(payload.enabled);
    }

    const existing = await WhatsappCommand.findOne(dedupeFilter)
      .sort({ createdAt: -1 })
      .lean();

    if (existing) {
      return { command: existing, deduplicated: true };
    }
  }

  const command = await createCommandRecord({
    companyId: normalizedCompanyId,
    type: normalizedType,
    payload,
    requestedBy,
  });

  if (queueDriver === QUEUE_DRIVERS.REDIS) {
    try {
      await enqueueRedisJob(command);
    } catch (error) {
      await WhatsappCommand.findByIdAndUpdate(command._id, {
        $set: {
          status: COMMAND_STATUSES.FAILED,
          processedAt: new Date(),
          lastError: `No se pudo encolar en Redis: ${error?.message || error}`,
        },
      });
      throw error;
    }
  }

  return { command, deduplicated: false };
};

const claimNextQueuedCommand = async ({ workerId }) => {
  const now = new Date();
  const staleLockLimit = new Date(now.getTime() - 5 * 60 * 1000);

  return WhatsappCommand.findOneAndUpdate(
    {
      $or: [
        { status: COMMAND_STATUSES.QUEUED },
        {
          status: COMMAND_STATUSES.PROCESSING,
          lockedAt: { $lte: staleLockLimit },
        },
      ],
    },
    {
      $set: {
        status: COMMAND_STATUSES.PROCESSING,
        lockedAt: now,
        lockedBy: workerId,
        processedAt: null,
        lastError: null,
      },
      $inc: { attempts: 1 },
    },
    {
      sort: { createdAt: 1 },
      returnDocument: "after",
    },
  );
};

const markCommandDone = async (commandId) => {
  await WhatsappCommand.findByIdAndUpdate(commandId, {
    $set: {
      status: COMMAND_STATUSES.DONE,
      processedAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
    },
  });
};

const markCommandFailed = async (command, errorMessage) => {
  const attempts = Number(command?.attempts || 0);
  const maxAttempts = Number(command?.maxAttempts || DEFAULT_MAX_ATTEMPTS);
  const shouldRetry = attempts < maxAttempts;

  await WhatsappCommand.findByIdAndUpdate(command._id, {
    $set: {
      status: shouldRetry ? COMMAND_STATUSES.QUEUED : COMMAND_STATUSES.FAILED,
      processedAt: shouldRetry ? null : new Date(),
      lockedAt: null,
      lockedBy: null,
      lastError:
        typeof errorMessage === "string" && errorMessage.trim()
          ? errorMessage
          : "Error desconocido",
    },
  });
};

const processCommand = async (command) => {
  const companyId = normalizeCompanyId(command.companyId || null);

  if (command.type === COMMAND_TYPES.SET_ENABLED) {
    const enabled = Boolean(command?.payload?.enabled);
    await setWhatsappEnabled(enabled, companyId);
    return;
  }

  if (command.type === COMMAND_TYPES.SEND_MESSAGE) {
    const to = String(command?.payload?.to || "").trim();
    const message = String(command?.payload?.message || "");
    if (!to || !message.trim()) {
      throw new Error("Payload inválido para SEND_MESSAGE.");
    }

    const client = getReadyClient(companyId);
    await client.sendMessage(to, message);
    return;
  }

  if (command.type === COMMAND_TYPES.RESTART_CLIENT) {
    await restartClient(companyId);
    return;
  }

  if (command.type === COMMAND_TYPES.LIST_GROUPS) {
    const groups = await listWhatsappGroups(companyId);
    await saveWhatsappGroupsSnapshot(companyId, groups, new Date());
    return;
  }

  if (command.type === COMMAND_TYPES.NOTIFY_CANCELLATION_GROUP) {
    await notifyCancellationToGroup({
      companyId,
      booking: command?.payload?.booking || null,
      time: command?.payload?.time,
      courtName: command?.payload?.courtName,
      cancelledBy: command?.payload?.cancelledBy,
    });
    return;
  }

  throw new Error(`Tipo de comando no soportado: ${command.type}`);
};

const processNextWhatsappCommand = async () => {
  if (queueDriver === QUEUE_DRIVERS.REDIS) {
    return false;
  }

  const workerId = normalizeWorkerId();
  const command = await claimNextQueuedCommand({ workerId });

  if (!command) return false;

  try {
    await processCommand(command);
    await markCommandDone(command._id);
    return true;
  } catch (error) {
    const message = String(error?.message || error || "Error desconocido");
    await markCommandFailed(command, message);
    console.error(
      `[WhatsAppCommandQueue][${workerId}] Error procesando comando ${command._id}:`,
      message,
    );
    return true;
  }
};

const runQueueSweep = async () => {
  if (monitorRunning) return;
  monitorRunning = true;

  try {
    while (true) {
      const processed = await processNextWhatsappCommand();
      if (!processed) break;
    }
  } finally {
    monitorRunning = false;
  }
};

const startWhatsappCommandMonitor = () => {
  if (queueDriver === QUEUE_DRIVERS.REDIS) {
    console.log("[WhatsAppCommandQueue] Driver redis activo: monitor Mongo deshabilitado en API.");
    return;
  }

  if (monitorTimer) return;

  monitorTimer = setInterval(() => {
    runQueueSweep().catch((error) => {
      console.error(
        "[WhatsAppCommandQueue] Error en barrido de comandos:",
        error?.message || error,
      );
    });
  }, DEFAULT_POLL_INTERVAL_MS);

  runQueueSweep().catch((error) => {
    console.error(
      "[WhatsAppCommandQueue] Error en barrido inicial:",
      error?.message || error,
    );
  });
};

module.exports = {
  COMMAND_TYPES,
  COMMAND_STATUSES,
  enqueueWhatsappCommand,
  startWhatsappCommandMonitor,
  processNextWhatsappCommand,
};
