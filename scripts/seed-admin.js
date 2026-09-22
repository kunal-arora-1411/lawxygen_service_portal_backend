import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import mongoose from "mongoose";

import { User } from "../src/models/user.model.js";

dotenv.config({ quiet: true });

const ADMIN_EMAIL = process.env.SEED_ADMIN_EMAIL;
const ADMIN_PASSWORD = process.env.SEED_ADMIN_PASSWORD;
const ADMIN_NAME = process.env.SEED_ADMIN_NAME || "Super Admin";

if (!ADMIN_EMAIL || !ADMIN_PASSWORD) {
  console.error("❌ SEED_ADMIN_EMAIL and SEED_ADMIN_PASSWORD must be set in your .env file");
  process.exit(1);
}

const run = async () => {
  await mongoose.connect(process.env.MONGO_URI);
  console.log("✅ MongoDB connected");

  const existing = await User.findOne({ email: ADMIN_EMAIL.toLowerCase() });

  if (existing) {
    console.log(`⏭️  Admin with email ${ADMIN_EMAIL} already exists`);
  } else {
    const hashedPassword = await bcrypt.hash(ADMIN_PASSWORD, 12);

    await User.create({
      name: ADMIN_NAME,
      email: ADMIN_EMAIL.toLowerCase().trim(),
      password: hashedPassword,
      role: "super_admin",
      isVerified: true,
      isActive: true,
    });

    console.log(`🎉 Super admin created: ${ADMIN_EMAIL}`);
  }

  await mongoose.connection.close();
  console.log("🔌 MongoDB connection closed");
};

run();
