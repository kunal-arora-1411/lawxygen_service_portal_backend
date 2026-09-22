import express from "express";

import {
  listMyDocuments,
  uploadDocument,
  deleteMyDocument,
  getMyDocumentStats,
} from "../../controllers/client/document.controller.js";

import { verifyJwt } from "../../middleware/auth.middleware.js";
import upload from "../../middleware/upload.middleware.js";

const router = express.Router();

router.use(verifyJwt);

router.get("/stats", getMyDocumentStats);

router.get("/", listMyDocuments);

router.post("/", upload.single("file"), uploadDocument);

router.delete("/:id", deleteMyDocument);

export default router;
