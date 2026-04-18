require("dotenv").config();

const mongoose = require("mongoose");
const { Queue } = require("bullmq");
const IORedis = require("ioredis");
const WhatsappCommand = require("../src/models/whatsappCommand.model");

const DEFAULT_QUEUE_NAME = "whatsapp-commands";
const DEFAULT_LIMIT = 500;

const parsePositiveInt = (value, fallback) => {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const parseLookbackHours = (value, fallback = 168) => {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
};

const createRedisConnection = () =>
  new IORedis({
    host: String(process.env.REDIS_HOST || "127.0.0.1").trim(),
    port: Number(process.env.REDIS_PORT || 6379),
    db: Number(process.env.REDIS_DB || 0),
    ...(String(process.env.REDIS_PASSWORD || "").trim()
      ? { password: String(process.env.REDIS_PASSWORD || "").trim() }
      : {}),
    ...(String(process.env.REDIS_TLS || "false").trim() === "true" ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  });

const run = async () => {
  const mongoUri = String(process.env.MONGO_URI || "").trim();
  if (!mongoUri) {
    throw new Error("MONGO_URI no está configurado.");
  }

  const queueName = String(
    process.env.WHATSAPP_QUEUE_NAME || DEFAULT_QUEUE_NAME,
  ).trim();
  const limit = parsePositiveInt(process.env.REQUEUE_LIMIT, DEFAULT_LIMIT);
  const lookbackHours = parseLookbackHours(process.env.REQUEUE_LOOKBACK_HOURS, 168);
  const createdAfter = new Date(Date.now() - lookbackHours * 60 * 60 * 1000);

  await mongoose.connect(mongoUri);

  const redis = createRedisConnection();
  const queue = new Queue(queueName, { connection: redis });

  try {
    const candidates = await WhatsappCommand.find({
      status: "queued",
      createdAt: { $gte: createdAfter },
    })
      .sort({ createdAt: 1 })
      .limit(limit)
      .select("_id companyId type payload maxAttempts")
      .lean();

    let enqueued = 0;
    let alreadyQueued = 0;
    let errors = 0;

    for (const command of candidates) {
      const commandId = String(command._id);
      try {
        await queue.add(
          "whatsapp-command",
          {
            commandId,
            companyId: command.companyId ? String(command.companyId) : null,
            type: command.type,
            payload: command.payload,
          },
          {
            jobId: commandId,
            attempts: Number(command.maxAttempts || 3),
            backoff: { type: "exponential", delay: 2000 },
            removeOnComplete: true,
            removeOnFail: false,
          },
        );
        enqueued += 1;
      } catch (error) {
        const message = String(error?.message || error || "");
        if (
          message.includes("already exists") ||
          message.includes("Job is already waiting")
        ) {
          alreadyQueued += 1;
          continue;
        }
        errors += 1;
        console.error(`[requeue] error commandId=${commandId}: ${message}`);
      }
    }

    console.log(
      JSON.stringify(
        {
          queueName,
          scanned: candidates.length,
          enqueued,
          alreadyQueued,
          errors,
          createdAfter: createdAfter.toISOString(),
          limit,
        },
        null,
        2,
      ),
    );
  } finally {
    await queue.close();
    await redis.quit();
    await mongoose.disconnect();
  }
};

run().catch((error) => {
  console.error("[requeue] fatal:", error?.message || error);
  process.exit(1);
});

