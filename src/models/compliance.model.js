import mongoose from "mongoose";

const complianceSchema = new mongoose.Schema(
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

    title: {
      type: String,
      required: true,
      trim: true,
    },

    description: {
      type: String,
      default: "",
    },

    dueAt: {
      type: Date,
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: ["upcoming", "due_soon", "completed", "overdue"],
      default: "upcoming",
      index: true,
    },

    completedAt: {
      type: Date,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const ComplianceItem = mongoose.model("ComplianceItem", complianceSchema);

export default ComplianceItem;
