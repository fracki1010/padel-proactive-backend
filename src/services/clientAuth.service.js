'use strict';

// WhatsApp-only client auth domain service.
//
// All persistence access goes through an injected `models` object
// ({ ClientAccount, User }) so the login/registration orchestration can be
// unit-tested without a live MongoDB connection. The controller wires the
// real Mongoose models in.

const {
  normalizeCanonicalClientPhone,
} = require("../utils/identityNormalization");

// ── Pure helpers ────────────────────────────────────────────────────────────

// Argentina: insert the mobile 9 between the country code (54) and the area
// code when it is missing.
const canonicalizePhone = (digits = "") => {
  if (digits.startsWith("54") && !digits.startsWith("549") && digits.length >= 12) {
    return "549" + digits.slice(2);
  }
  return digits;
};

// Combines countryCode + localNumber, keeps digits only and canonizes the
// Argentine format.
const buildNormalizedPhone = (countryCode = "", localNumber = "") => {
  const raw = `${countryCode}${localNumber}`;
  return canonicalizePhone(normalizeCanonicalClientPhone(raw));
};

// MongoDB query that matches a phone in both stored formats (with and without
// the Argentine 9) for backwards compatibility with older records.
const phoneMatchQuery = (phone = "") => {
  if (phone.startsWith("549") && phone.length >= 13) {
    return { $in: [phone, "54" + phone.slice(3)] };
  }
  return phone;
};

// Which branch a verified phone resolves to.
const decidePhoneLogin = ({ hasClientAccount, hasUser }) => {
  if (hasClientAccount) return { action: "login" };
  if (hasUser) return { action: "login", linkUser: true };
  return { action: "needs_name" };
};

// Google never bypasses phone verification: a Google sign-in without a
// verified phone must complete the OTP flow.
const planGoogleAuth = ({ phoneProvided, otpProvided }) => {
  if (!phoneProvided) return "needs_phone";
  if (!otpProvided) return "needs_otp";
  return "verify_otp";
};

// ── Persistence orchestration ───────────────────────────────────────────────

// Verifies an OTP code for a phone. Returns { valid, reason?, otp? }.
const verifyOtpCode = async ({ companyId, phone, code, OtpVerification }) => {
  if (!code) return { valid: false, reason: "Código de verificación requerido" };

  const otp = await OtpVerification.findOne({
    companyId,
    phone: phoneMatchQuery(phone),
    used: false,
    expiresAt: { $gt: new Date() },
  });
  if (!otp) return { valid: false, reason: "Código inválido o expirado" };
  if (otp.code !== String(code)) return { valid: false, reason: "Código incorrecto" };
  return { valid: true, otp };
};

// Creates the ClientAccount linked to an already known User (e.g. a client who
// booked through the WhatsApp bot) without password nor email.
const createClientAccountForUser = async ({ companyId, phone, user, name, models }) => {
  const client = await models.ClientAccount.create({
    companyId,
    name: name || user.name,
    email: "",
    phone,
    passwordHash: "",
    googleAuth: false,
  });
  client.linkedUserId = user._id;
  await client.save();
  return client;
};

// Resolves a just-verified phone to a client session.
// Returns { kind: "login", client } or { kind: "needs_name", phone }.
const resolveClientByVerifiedPhone = async ({ companyId, phone, models }) => {
  const clientAccount = await models.ClientAccount.findOne({
    companyId,
    phone: phoneMatchQuery(phone),
    isActive: true,
  });

  const user = clientAccount
    ? null
    : await models.User.findOne({ companyId, phoneNumber: phoneMatchQuery(phone) });

  const decision = decidePhoneLogin({
    hasClientAccount: Boolean(clientAccount),
    hasUser: Boolean(user),
  });

  if (decision.action === "needs_name") {
    return { kind: "needs_name", phone };
  }

  const client = clientAccount
    ? clientAccount
    : await createClientAccountForUser({ companyId, phone, user, models });

  return { kind: "login", client };
};

// Creates a brand-new User + ClientAccount for a phone that has no record.
const completeRegistration = async ({
  companyId,
  phone,
  name,
  models,
  origin = "sistema",
  whatsappId,
}) => {
  const trimmedName = String(name || "").trim();

  const user = await models.User.create({
    companyId,
    whatsappId: whatsappId || `${phone}@c.us`,
    name: trimmedName,
    phoneNumber: phone,
    accountOrigin: origin,
  });

  const client = await models.ClientAccount.create({
    companyId,
    name: trimmedName,
    email: "",
    phone,
    passwordHash: "",
    googleAuth: false,
  });
  client.linkedUserId = user._id;
  await client.save();

  return client;
};

module.exports = {
  canonicalizePhone,
  buildNormalizedPhone,
  phoneMatchQuery,
  decidePhoneLogin,
  planGoogleAuth,
  verifyOtpCode,
  resolveClientByVerifiedPhone,
  completeRegistration,
};
