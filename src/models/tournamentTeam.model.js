const mongoose = require("mongoose");

const tournamentTeamSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    tournament: { type: mongoose.Schema.Types.ObjectId, ref: "Tournament", required: true },
    category: { type: mongoose.Schema.Types.ObjectId, ref: "TournamentCategory", required: true },
    name: { type: String, required: true, trim: true },
    player1Name: { type: String, default: "", trim: true },
    player2Name: { type: String, default: "", trim: true },
    // Optional per-player identity used to reject duplicate players inside a
    // category: `userId` when the player has an account, otherwise the
    // normalized name plus phone.
    player1UserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    player2UserId: { type: mongoose.Schema.Types.ObjectId, ref: "User", default: null },
    player1Phone: { type: String, default: "", trim: true },
    player2Phone: { type: String, default: "", trim: true },
    seed: {
      type: Number,
      default: null,
      min: 1,
      validate: {
        validator: (value) => value === null || Number.isInteger(value),
        message: "seed debe ser un entero positivo.",
      },
    },
    status: { type: String, enum: ["registered", "withdrawn"], default: "registered" },
  },
  { timestamps: true },
);

tournamentTeamSchema.index({ category: 1, name: 1 }, { unique: true });
tournamentTeamSchema.index({ companyId: 1, category: 1 });

module.exports = mongoose.model("TournamentTeam", tournamentTeamSchema);
