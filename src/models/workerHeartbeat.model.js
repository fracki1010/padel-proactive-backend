const mongoose = require("mongoose");

const workerHeartbeatSchema = new mongoose.Schema(
  {
    serviceName: {
      type: String,
      required: true,
      trim: true,
      unique: true,
      index: true,
    },
    workerId: {
      type: String,
      default: null,
      trim: true,
    },
    host: {
      type: String,
      default: null,
      trim: true,
    },
    pid: {
      type: Number,
      default: null,
    },
    heartbeatAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

module.exports = mongoose.model("WorkerHeartbeat", workerHeartbeatSchema);
