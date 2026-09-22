import mongoose from "mongoose";

const appointmentSchema = new mongoose.Schema(
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

    professional: {
      type: mongoose.Schema.Types.ObjectId,
      ref: "User",
      default: null,
      index: true,
    },

    scheduledAt: {
      type: Date,
      required: true,
      index: true,
    },

    durationMinutes: {
      type: Number,
      default: 30,
      min: 0,
    },

    mode: {
      type: String,
      enum: ["video", "phone", "in_person"],
      default: "video",
    },

    topic: {
      type: String,
      trim: true,
      default: "",
    },

    status: {
      type: String,
      enum: ["requested", "confirmed", "completed", "missed", "cancelled"],
      default: "requested",
      index: true,
    },

    joinUrl: {
      type: String,
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

const Appointment = mongoose.model("Appointment", appointmentSchema);

export default Appointment;
