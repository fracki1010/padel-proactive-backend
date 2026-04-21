// src/seed/seedAdmin.js
require("dotenv").config();
const mongoose = require("mongoose");
const Admin = require("../models/admin.model");
const connectDB = require("../config/database");

const seedAdmin = async () => {
  try {
    await connectDB();

    const username = process.env.SEED_SUPER_ADMIN_USER || "superadmin";
    const password = process.env.SEED_SUPER_ADMIN_PASS || "franco-nicolas-123";

    const existingAdmin = await Admin.findOne({ username });
    if (existingAdmin) {
      console.log("Admin ya existe.");
      process.exit(0);
    }

    await Admin.create({
      username,
      password,
      role: "super_admin",
    });

    console.log("Super admin creado exitosamente:");
    console.log("Usuario:", username);
    console.log("Password:", password);
    process.exit(0);
  } catch (error) {
    console.error("Error al crear admin:", error);
    process.exit(1);
  }
};

seedAdmin();
