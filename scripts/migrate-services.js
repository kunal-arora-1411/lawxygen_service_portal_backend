import fs from "fs";
import path from "path";
import mongoose from "mongoose";
import dotenv from "dotenv";

import Service from "../src/models/service.model.js";

dotenv.config();

const SERVICES_PATH = process.env.FRONTEND_SERVICES_PATH;

if (!SERVICES_PATH) {
  console.error("❌ FRONTEND_SERVICES_PATH is missing from your .env file");
  process.exit(1);
}

console.log("📂 Frontend services path:");
console.log(SERVICES_PATH);

const connectDB = async () => {
  try {
    await mongoose.connect(process.env.MONGO_URI);

    console.log("✅ MongoDB connected");
  } catch (error) {
    console.error("❌ MongoDB connection failed");
    console.error(error);
    process.exit(1);
  }
};

const findPageFiles = (directory) => {
  const results = [];

  const entries = fs.readdirSync(directory, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      results.push(...findPageFiles(fullPath));
    }

    if (entry.isFile() && entry.name === "page.tsx") {
      results.push(fullPath);
    }
  }

  return results;
};

const extractDataObject = (filePath) => {
  const sourceCode = fs.readFileSync(filePath, "utf-8");

  const dataStart = sourceCode.indexOf("const data =");

  if (dataStart === -1) {
    return null;
  }

  const objectStart = sourceCode.indexOf("{", dataStart);

  if (objectStart === -1) {
    return null;
  }

  let depth = 0;
  let objectEnd = -1;

  let inString = false;
  let stringChar = null;
  let escaped = false;

  for (let i = objectStart; i < sourceCode.length; i++) {
    const char = sourceCode[i];

    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        continue;
      }

      if (char === stringChar) {
        inString = false;
        stringChar = null;
      }

      continue;
    }

    if (char === '"' || char === "'" || char === "`") {
      inString = true;
      stringChar = char;
      continue;
    }

    if (char === "{") {
      depth++;
    }

    if (char === "}") {
      depth--;

      if (depth === 0) {
        objectEnd = i;
        break;
      }
    }
  }

  if (objectEnd === -1) {
    console.error(`❌ Could not find end of data object: ${filePath}`);
    return null;
  }

  const dataText = sourceCode.slice(objectStart, objectEnd + 1);

  try {
    return Function(`"use strict"; return (${dataText});`)();
  } catch (error) {
    console.error(`❌ Could not parse data in: ${filePath}`);
    console.error(error.message);

    return null;
  }
};

const getServiceInfoFromPath = (filePath) => {
  const relativePath = path.relative(SERVICES_PATH, filePath);

  const parts = relativePath.split(path.sep);

  if (parts.length < 3) {
    return null;
  }

  const categorySlug = parts[0];
  const slug = parts[parts.length - 2];

  return {
    categorySlug,
    slug,
  };
};

const run = async () => {
  console.log("\n🚀 Starting service migration...\n");

  if (!fs.existsSync(SERVICES_PATH)) {
    console.error("❌ Services directory does not exist:");
    console.error(SERVICES_PATH);
    process.exit(1);
  }

  // Connect to MongoDB
  await connectDB();

  const files = findPageFiles(SERVICES_PATH);

  console.log(`📄 Found ${files.length} page.tsx files\n`);

  let validServices = 0;
  let skippedFiles = 0;
  let insertedServices = 0;
  let existingServices = 0;
  let failedServices = 0;

  for (const file of files) {
    console.log("\n----------------------------------------");
    console.log(`📄 ${file}`);

    try {
      // Extract data from page.tsx
      const data = extractDataObject(file);

      if (!data) {
        console.log("⏭️ Skipped - no data object found");
        skippedFiles++;
        continue;
      }

      // Get slug and category from folder structure
      const serviceInfo = getServiceInfoFromPath(file);

      if (!serviceInfo) {
        console.log("⏭️ Skipped - could not determine slug");
        skippedFiles++;
        continue;
      }

      const service = {
        ...data,

        slug: serviceInfo.slug,

        categorySlug:
          data.categorySlug || serviceInfo.categorySlug,
      };

      validServices++;

      console.log("🔎 Service detected:");
      console.log({
        title: service.title,
        slug: service.slug,
        category: service.category,
        categorySlug: service.categorySlug,
      });

      // Check if service already exists
      const existingService = await Service.findOne({
        slug: service.slug,
      });

      if (existingService) {
        console.log("⏭️ Already exists - skipping");

        existingServices++;
        continue;
      }

      // Insert service
      await Service.create(service);

      console.log("✅ Service inserted successfully");

      insertedServices++;
    } catch (error) {
      console.error("❌ Failed to migrate service");
      console.error(error.message);

      failedServices++;
    }
  }

  console.log("\n========================================");
  console.log("🎉 Migration completed");
  console.log("========================================");

  console.log(`Total page.tsx files: ${files.length}`);
  console.log(`Valid services: ${validServices}`);
  console.log(`Inserted: ${insertedServices}`);
  console.log(`Already existed: ${existingServices}`);
  console.log(`Skipped: ${skippedFiles}`);
  console.log(`Failed: ${failedServices}`);

  await mongoose.connection.close();

  console.log("\n🔌 MongoDB connection closed");
};

run();
