import mongoose from "mongoose";

const documentSchema = new mongoose.Schema(
  {
    client: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    serviceMatter: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "ServiceMatter",
      default: null,
    },

    fileName: {
      type: String,
      required: true,
    },

    fileUrl: {
      type: String,
      required: true,
    },

    mimeType: {
      type: String,
      default: "",
    },

    sizeBytes: {
      type: Number,
      default: 0,
    },

    status: {
      type: String,
      enum: ["uploaded", "in_review", "verified", "rejected"],
      default: "uploaded",
      index: true,
    },

    reviewNote: {
      type: String,
      default: null,
    },

    uploadedAt: {
      type: Date,
      default: Date.now,
    },

    reviewedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const Document = mongoose.model("Document", documentSchema);

export default Document;
