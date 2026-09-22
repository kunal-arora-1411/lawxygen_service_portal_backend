import express from "express";

import {
  listDocumentsAdmin,
  updateDocumentStatusAdmin,
} from "../../controllers/admin/document.controller.js";

import { verifyJwt, verifyAdmin } from "../../middleware/auth.middleware.js";

const router = express.Router();

router.use(verifyJwt, verifyAdmin);

router.get("/", listDocumentsAdmin);

router.patch("/:id", updateDocumentStatusAdmin);

export default router;
