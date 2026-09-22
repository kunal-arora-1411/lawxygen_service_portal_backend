import mongoose from "mongoose";

const serviceMatterSchema = new mongoose.Schema(
  {
    client: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      required: true,
      index: true,
    },

    service: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "Service",
      required: true,
    },

    serviceSnapshot: {
      title: {
        type: String,
        required: true,
      },

      slug: {
        type: String,
        required: true,
      },

      price: {
        type: Number,
        default: 0,
      },
    },

    professional: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    assignedBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
    },

    status: {
      type: String,
      enum: [
        "PAYMENT_PENDING",
        "PAID",
        "ASSIGNED",
        "IN_PROGRESS",
        "ACTION_REQUIRED",
        "UNDER_REVIEW",
        "COMPLETED",
        "CANCELLED",
      ],
      default: "PAYMENT_PENDING",
      index: true,
    },

    progress: {
      type: Number,
      default: 0,
      min: 0,
      max: 100,
    },

    currentStep: {
      type: Number,
      default: 0,
    },

    totalSteps: {
      type: Number,
      default: 0,
    },

    currentStepTitle: {
      type: String,
      default: "",
    },

    actionRequired: {
      type: Boolean,
      default: false,
    },

    actionMessage: {
      type: String,
      default: "",
    },

    assignedAt: {
      type: Date,
      default: null,
    },

    startedAt: {
      type: Date,
      default: null,
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

const ServiceMatter = mongoose.model(
  "ServiceMatter",
  serviceMatterSchema
);

export default ServiceMatter;