const mongoose = require("mongoose");

const ISO_DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const tournamentMatchSchema = new mongoose.Schema(
  {
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: "Company", required: true, index: true },
    tournament: { type: mongoose.Schema.Types.ObjectId, ref: "Tournament", required: true },
    category: { type: mongoose.Schema.Types.ObjectId, ref: "TournamentCategory", required: true },
    // The bracket tree is derived from (round, position); it is never persisted.
    // Round 1 is the first round; the final is log2(bracketSize).
    round: {
      type: Number,
      required: true,
      min: 1,
      validate: { validator: Number.isInteger, message: "round must be an integer." },
    },
    position: {
      type: Number,
      required: true,
      min: 0,
      validate: { validator: Number.isInteger, message: "position must be an integer." },
    },
    teamA: { type: mongoose.Schema.Types.ObjectId, ref: "TournamentTeam", default: null },
    teamB: { type: mongoose.Schema.Types.ObjectId, ref: "TournamentTeam", default: null },
    winner: { type: mongoose.Schema.Types.ObjectId, ref: "TournamentTeam", default: null },
    scoreA: { type: Number, default: null },
    scoreB: { type: Number, default: null },
    status: { type: String, enum: ["pending", "ready", "played", "bye"], default: "pending" },
    court: { type: mongoose.Schema.Types.ObjectId, ref: "Court", default: null },
    date: {
      type: String,
      default: null,
      validate: {
        validator: (value) => value === null || ISO_DATE_REGEX.test(value),
        message: "date must use YYYY-MM-DD.",
      },
    },
    timeSlot: { type: mongoose.Schema.Types.ObjectId, ref: "TimeSlot", default: null },
  },
  { timestamps: true },
);

tournamentMatchSchema.index({ category: 1, round: 1, position: 1 }, { unique: true });
tournamentMatchSchema.index({ companyId: 1, tournament: 1 });
tournamentMatchSchema.index({ companyId: 1, court: 1, date: 1 });

module.exports = mongoose.model("TournamentMatch", tournamentMatchSchema);
