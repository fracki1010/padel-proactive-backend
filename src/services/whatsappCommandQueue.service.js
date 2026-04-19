const WhatsappCommand = require("../models/whatsappCommand.model");

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

const queueDriver = String(process.env.WHATSAPP_QUEUE_DRIVER || QUEUE_DRIVERS.REDIS)
  .trim()
  .toLowerCase();
const allowMongoFallback =
  String(process.env.WHATSAPP_ALLOW_MONGO_FALLBACK || "false")
    .trim()
    .toLowerCase() === "true";

const DEFAULT_MAX_ATTEMPTS = Number(
  process.env.WHATSAPP_COMMAND_MAX_ATTEMPTS || 3,
);

let redisQueueInstance = null;

const normalizeCompanyId = (companyId = null) => companyId || null;

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
    return { command, deduplicated: false };
  }

  if (allowMongoFallback) {
    console.warn(
      "[WhatsAppCommandQueue] Fallback Mongo activo (solo desarrollo). El worker Redis/BullMQ no está en uso.",
    );
    return { command, deduplicated: false };
  }

  await WhatsappCommand.findByIdAndUpdate(command._id, {
    $set: {
      status: COMMAND_STATUSES.FAILED,
      processedAt: new Date(),
      lastError:
        "Flujo inválido: backend API configurado sin Redis/BullMQ. Definí WHATSAPP_QUEUE_DRIVER=redis o habilitá WHATSAPP_ALLOW_MONGO_FALLBACK=true para desarrollo.",
    },
  });

  throw new Error(
    "Backend API sin Redis/BullMQ: WHATSAPP_QUEUE_DRIVER debe ser 'redis' en producción.",
  );
};

const startWhatsappCommandMonitor = () => {
  if (queueDriver === QUEUE_DRIVERS.REDIS) {
    return;
  }
  if (!allowMongoFallback) {
    console.warn(
      "[WhatsAppCommandQueue] Monitor local deshabilitado. Usá whatsapp-worker con Redis/BullMQ.",
    );
  }
};

const processNextWhatsappCommand = async () => false;

module.exports = {
  COMMAND_TYPES,
  COMMAND_STATUSES,
  QUEUE_DRIVERS,
  enqueueWhatsappCommand,
  startWhatsappCommandMonitor,
  processNextWhatsappCommand,
};
