// src/services/userService.js
const User = require("../models/user.model");
const { getNumberByUser } = require("../utils/getNumberByUser");
const {
  isLidIdentifier,
  normalizePhoneDigits,
} = require("../whatsapp/domain/clientIdentity");

// Buscar usuario por su ID de WhatsApp
const getUserByWhatsappId = async (whatsappId, options = {}) => {
  try {
    const companyId = options.companyId || null;
    return await User.findOne({ whatsappId, companyId });
  } catch (error) {
    console.error("Error buscando usuario:", error);
    return null;
  }
};

// Link an incoming WhatsApp id as an alias of `user`. Aliases are unique per
// company: if another user already owns the id, do NOT steal it, just return the
// authoritative user. Duplicate-key races are swallowed so message handling
// never breaks.
const linkWhatsappAlias = async ({ user, incomingId, companyId }) => {
  if (!user) return user;

  const aliases = Array.isArray(user.whatsappAliases) ? user.whatsappAliases : [];
  const alreadyLinked = user.whatsappId === incomingId || aliases.includes(incomingId);
  if (alreadyLinked) return user;

  try {
    const owner = await User.findOne({
      companyId,
      whatsappAliases: incomingId,
      _id: { $ne: user._id },
    });
    if (owner) return user;

    return await User.findOneAndUpdate(
      { _id: user._id },
      { $addToSet: { whatsappAliases: incomingId } },
      { new: true },
    );
  } catch (error) {
    // A rare race can hit the unique compound index; keep the authoritative user.
    console.warn(`No pude vincular el alias ${incomingId}:`, error.message);
    return user;
  }
};

// Resolve a User from a WhatsApp identity. Precedence: the AUTHORITATIVE, server
// resolved phone outranks a stored alias, and an alias is only a fallback. This
// prevents a stale/incorrect alias from permanently shadowing the real phone.
// Always scoped by companyId (which may be null, matching existing lookups):
//   1. exact `whatsappId` (current match);
//   2. exact resolved phone as `whatsappId` "<phone>@c.us", else `phoneNumber`;
//   3. already-linked `whatsappAliases` (fallback when the phone cannot resolve).
// When found via the phone, the incoming chatId is linked as an alias so the
// link survives for future messages. `whatsappId` is never overwritten.
//
// Deliberately uses EXACT phone equality. The portal's 54…↔549… collapse is NOT
// used here: collapsing mobile/landline could match the WRONG person.
const getUserByIdentity = async ({ chatId, resolvedPhone, companyId = null }) => {
  try {
    const scope = { companyId };
    const incomingId = String(chatId || "").trim();
    if (!incomingId) return null;

    // 1. Exact current WhatsApp id.
    const byWhatsappId = await User.findOne({ ...scope, whatsappId: incomingId });
    if (byWhatsappId) return byWhatsappId;

    // 2. Authoritative phone resolution (exact digits, AR mobile "9" preserved).
    const phone = normalizePhoneDigits(resolvedPhone);
    if (phone) {
      const byPhone =
        (await User.findOne({ ...scope, whatsappId: `${phone}@c.us` })) ||
        (await User.findOne({ ...scope, phoneNumber: phone }));
      if (byPhone) {
        return await linkWhatsappAlias({ user: byPhone, incomingId, companyId });
      }
    }

    // 3. Alias fallback (only reached when the phone did not resolve to a user).
    const byAlias = await User.findOne({ ...scope, whatsappAliases: incomingId });
    return byAlias || null;
  } catch (error) {
    console.error("Error resolviendo identidad de usuario:", error);
    return null;
  }
};

// Crear o Actualizar usuario
// El nombre solo se guarda la primera vez; una vez registrado no puede cambiarse por WhatsApp.
const saveOrUpdateUser = async (whatsappId, name, options = {}) => {
  try {
    const companyId = options.companyId || null;
    const cleanPhone = await getNumberByUser(whatsappId, companyId);

    // A Linked-Device ID (@lid) is not a phone number. A LID-derived phone must
    // never be persisted: it would split the person's identity (unique index on
    // companyId + phoneNumber) and could merge a wrong user.
    const isLid = isLidIdentifier(whatsappId);
    const lidDigits = String(whatsappId || "").split("@")[0].replace(/\D/g, "");
    const phoneIsLidDerived = isLid && (!cleanPhone || cleanPhone === lidDigits);
    const usablePhone = phoneIsLidDerived ? "" : cleanPhone;

    // Resolve an existing identity FIRST: exact whatsappId, linked alias, or the
    // verified phone. This keeps a verified client recognized when they write
    // from a Linked-Device id instead of creating a duplicate User.
    const existingUser = await getUserByIdentity({
      chatId: whatsappId,
      resolvedPhone: usablePhone,
      companyId,
    });

    if (existingUser) {
      // Never change the stored `name`, `phoneNumber` or `whatsappId`. Alias
      // linking (guarded, unique-per-company) is already done by
      // getUserByIdentity via linkWhatsappAlias, so only refresh the timestamp.
      const updated = await User.findOneAndUpdate(
        { _id: existingUser._id },
        { $set: { lastInteraction: new Date() } },
        { new: true },
      );
      return updated || existingUser;
    }

    // `phoneNumber` is required (and covered by a partial unique index). If the
    // identity has no usable phone and no existing user, do NOT upsert: a phone
    // cannot be fabricated, and `findOneAndUpdate` would otherwise insert an
    // invalid, phone-less User because validators are not run.
    if (!usablePhone) {
      return null;
    }

    const user = await User.findOneAndUpdate(
      { whatsappId, companyId },
      {
        $set: {
          companyId,
          whatsappId,
          name,
          phoneNumber: usablePhone,
          lastInteraction: new Date(),
        },
        $setOnInsert: { accountOrigin: "whatsapp" },
      },
      { upsert: true, returnDocument: "after" },
    );
    return user;
  } catch (error) {
    console.error("Error guardando usuario:", error);
  }
};

module.exports = { getUserByWhatsappId, getUserByIdentity, saveOrUpdateUser };
