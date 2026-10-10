'use strict';

// Pure helpers for the optional search + pagination on GET /api/users.
// Kept dependency-free so they can be unit tested without a live MongoDB.

const escapeRegExp = (value) =>
  String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Parse `search` / `page` / `limit` from a request query object.
// - search: trimmed string (default "")
// - page: int >= 1 (default 1)
// - limit: int 1..50 (default 10)
// - isPaginated: true when the caller asked for search or pagination
//   explicitly. When false the controller keeps its legacy full-list path.
const parseUserListParams = (query = {}) => {
  const rawSearch =
    typeof query.search === "string" ? query.search.trim() : "";

  const rawPage =
    query.page === undefined || query.page === ""
      ? undefined
      : Number(query.page);
  const rawLimit =
    query.limit === undefined || query.limit === ""
      ? undefined
      : Number(query.limit);

  const isPaginated =
    rawSearch !== "" ||
    (rawPage !== undefined && Number.isFinite(rawPage)) ||
    (rawLimit !== undefined && Number.isFinite(rawLimit));

  const page = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
  const limit =
    Number.isInteger(rawLimit) && rawLimit >= 1 && rawLimit <= 50
      ? rawLimit
      : 10;

  return { search: rawSearch, page, limit, isPaginated };
};

// Build a digit-matching pattern from the normalized search digits. Stored
// phone values are NOT normalized on write (e.g. "+54 9 262 251 7447"), so a
// literal digit substring would miss formatted entries. Allowing any run of
// non-digit characters between consecutive digits matches "entries whose
// digits include the term" regardless of separators, and is a strict superset
// of the contiguous-digit case.
const buildDigitsPattern = (digits) =>
  digits
    .split("")
    .map((digit) => escapeRegExp(digit))
    .join("\\D*");

// Build a Mongo $or filter for the combined User + unlinked ClientAccount
// sources. Every user-provided piece is escaped before being interpolated
// into a RegExp (no raw input ever reaches the regex engine).
//
//   - name: case-insensitive substring on the raw term.
//   - phone: the term is normalized to digits; when it has digits, match
//     entries whose digits contain that sequence. Users store `phoneNumber`,
//     ClientAccounts store `phone`.
const buildSearchCondition = (search) => {
  const term = String(search || "").trim();
  if (!term) return null;

  const conditions = [{ name: { $regex: escapeRegExp(term), $options: "i" } }];

  const digits = term.replace(/\D/g, "");
  if (digits) {
    const digitsPattern = buildDigitsPattern(digits);
    conditions.push({ phoneNumber: { $regex: digitsPattern } });
    conditions.push({ phone: { $regex: digitsPattern } });
  }

  return { $or: conditions };
};

// Slice a sorted combined list by page/limit and return the matching total.
const paginateUserList = (combined, page, limit) => {
  const total = combined.length;
  const start = (page - 1) * limit;
  return { items: combined.slice(start, start + limit), total };
};

module.exports = {
  buildDigitsPattern,
  escapeRegExp,
  parseUserListParams,
  buildSearchCondition,
  paginateUserList,
};