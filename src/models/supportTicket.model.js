import mongoose from "mongoose";

const supportTicketSchema = new mongoose.Schema(
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

    subject: {
      type: String,
      required: true,
      trim: true,
    },

    language: {
      type: String,
      default: null,
    },

    status: {
      type: String,
      enum: ["waiting", "in_progress", "resolved"],
      default: "waiting",
      index: true,
    },

    waitStartedAt: {
      type: Date,
      default: Date.now,
    },

    resolvedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const SupportTicket = mongoose.model("SupportTicket", supportTicketSchema);

export default SupportTicket;
