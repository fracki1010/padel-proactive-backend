const mongoose = require("mongoose");

const tournamentTeamSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    tournament: { type: mongoose.Schema.Types.ObjectId, ref: "Tournament", required: true },
    category: { type: mongoose.Schema.Types.ObjectId, ref: "TournamentCategory", required: true },
    name: { type: String, required: true, trim: true },
    player1Name: { type: String, default: "", trim: true },
    player2Name: { type: String, default: "", trim: true },
    seed: {
      type: Number,
      default: null,
      min: 1,
      validate: {
        validator: (value) => value === null || Number.isInteger(value),
        message: "seed must be a positive integer.",
      },
    },
    status: { type: String, enum: ["registered", "withdrawn"], default: "registered" },
  },
  { timestamps: true },
);

tournamentTeamSchema.index({ category: 1, name: 1 }, { unique: true });
tournamentTeamSchema.index({ companyId: 1, category: 1 });

module.exports = mongoose.model("TournamentTeam", tournamentTeamSchema);
