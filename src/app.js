import path from "path";
import express from "express";
import cookieParser from "cookie-parser";
import cors from "cors";
import dotenv from "dotenv";

import clientRoutes from "./routes/client/index.js";
import adminRoutes from "./routes/admin/index.js";
import professionalRoutes from "./routes/professional/index.js";
import errorMiddleware from "./middleware/error.middleware.js";
import ApiError from "./utils/ApiError.js";

dotenv.config({ quiet: true });

const app = express();

app.use(
  cors({
    origin: process.env.CLIENT_URL,
    credentials: true,
  }),
);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

app.use("/uploads", express.static(path.resolve("uploads")));

app.use("/api/client", clientRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/professional", professionalRoutes);

app.use((req, res, next) => {
  next(new ApiError(404, `Route not found: ${req.method} ${req.originalUrl}`));
});

app.use(errorMiddleware);

export default app;
