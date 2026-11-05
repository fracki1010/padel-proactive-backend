const mongoose = require("mongoose");

const tournamentCategorySchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    tournament: { type: mongoose.Schema.Types.ObjectId, ref: "Tournament", required: true },
    name: { type: String, required: true, trim: true },
    maxTeams: {
      type: Number,
      default: null,
      min: 2,
      max: 64,
      validate: {
        validator: (value) => value === null || Number.isInteger(value),
        message: "maxTeams must be an integer.",
      },
    },
    seeding: { type: String, enum: ["manual", "shuffle"], default: "shuffle" },
    // Filled by the bracket engine when the category is generated.
    bracketSize: { type: Number, default: null },
    status: { type: String, enum: ["draft", "active", "completed"], default: "draft" },
  },
  { timestamps: true },
);

tournamentCategorySchema.index({ tournament: 1, name: 1 }, { unique: true });
tournamentCategorySchema.index({ companyId: 1, tournament: 1 });

module.exports = mongoose.model("TournamentCategory", tournamentCategorySchema);
