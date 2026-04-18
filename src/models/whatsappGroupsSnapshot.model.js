const mongoose = require("mongoose");

const whatsappGroupSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    name: { type: String, default: "", trim: true },
  },
  { _id: false },
);

const whatsappGroupsSnapshotSchema = new mongoose.Schema(
  {
    companyId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Company",
      default: null,
    },
    groups: {
      type: [whatsappGroupSchema],
      default: [],
    },
    refreshedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  },
);

whatsappGroupsSnapshotSchema.index({ companyId: 1 }, { unique: true });

module.exports = mongoose.model(
  "WhatsappGroupsSnapshot",
  whatsappGroupsSnapshotSchema,
);
