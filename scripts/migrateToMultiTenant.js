require("dotenv").config();
const mongoose = require("mongoose");
const connectDB = require("../src/config/database");
const Company = require("../src/models/company.model");
const Admin = require("../src/models/admin.model");
const Court = require("../src/models/court.model");
const TimeSlot = require("../src/models/timeSlot.model");
const Booking = require("../src/models/booking.model");
const User = require("../src/models/user.model");
const Notification = require("../src/models/notification.model");
const AppConfig = require("../src/models/appConfig.model");

const normalizeSlug = (value = "") =>
  String(value)
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

const run = async () => {
  const companyName = process.env.MIGRATION_COMPANY_NAME || "Club Principal";
  const companySlug =
    process.env.MIGRATION_COMPANY_SLUG || normalizeSlug(companyName);

  if (!companySlug) {
    throw new Error("No se pudo calcular MIGRATION_COMPANY_SLUG");
  }

  await connectDB();

  let company = await Company.findOne({ slug: companySlug });
  if (!company) {
    company = await Company.create({ name: companyName, slug: companySlug });
    console.log(`[migration] Empresa creada: ${company.name} (${company.slug})`);
  } else {
    console.log(`[migration] Empresa existente: ${company.name} (${company.slug})`);
  }

  const companyId = company._id;

  const [courts, slots, bookings, users, notifications, configs, admins] =
    await Promise.all([
      Court.updateMany({ companyId: null }, { $set: { companyId } }),
      TimeSlot.updateMany({ companyId: null }, { $set: { companyId } }),
      Booking.updateMany({ companyId: null }, { $set: { companyId } }),
      User.updateMany({ companyId: null }, { $set: { companyId } }),
      Notification.updateMany({ companyId: null }, { $set: { companyId } }),
      AppConfig.updateMany({ companyId: null }, { $set: { companyId } }),
      Admin.updateMany(
        {
          role: { $in: ["admin", "manager"] },
          companyId: null,
        },
        { $set: { companyId, isActive: true } },
      ),
    ]);

  console.log("[migration] Registros actualizados:");
  console.log(`- courts: ${courts.modifiedCount || 0}`);
  console.log(`- slots: ${slots.modifiedCount || 0}`);
  console.log(`- bookings: ${bookings.modifiedCount || 0}`);
  console.log(`- users: ${users.modifiedCount || 0}`);
  console.log(`- notifications: ${notifications.modifiedCount || 0}`);
  console.log(`- appConfig: ${configs.modifiedCount || 0}`);
  console.log(`- admins: ${admins.modifiedCount || 0}`);

  await mongoose.connection.close();
  console.log("[migration] Finalizada correctamente.");
};

run().catch(async (error) => {
  console.error("[migration] Error:", error);
  await mongoose.connection.close();
  process.exit(1);
});
