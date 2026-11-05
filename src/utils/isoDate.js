// UTC "YYYY-MM-DD" string used to compare calendar days that are stored as
// UTC-midnight Dates or as plain `YYYY-MM-DD` strings. Formatting in UTC keeps
// the stored day stable regardless of the process timezone.
const toIsoDateString = (value) => {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "");
  return date.toISOString().slice(0, 10);
};

module.exports = { toIsoDateString };
