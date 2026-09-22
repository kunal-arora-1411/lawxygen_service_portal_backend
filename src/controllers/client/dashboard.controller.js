import ServiceMatter from "../../models/serviceMatter.model.js";
import ComplianceItem from "../../models/compliance.model.js";
import Appointment from "../../models/appointment.model.js";
import Document from "../../models/document.model.js";
import ApiResponse from "../../utils/ApiResponse.js";
import asyncHandler from "../../utils/asyncHandler.js";

const ACTIVE_MATTER_STATUSES = ["PAID", "ASSIGNED", "IN_PROGRESS", "ACTION_REQUIRED", "UNDER_REVIEW"];

/**
 * GET /api/client/dashboard/stats
 */
export const getClientDashboardStats = asyncHandler(async (req, res) => {
  const clientId = req.user._id;
  const now = new Date();

  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  const [
    activeServices,
    servicesNeedingAction,
    nextCompliance,
    upcomingCompliance,
    appointmentsBooked,
    nextAppointment,
    documentsCount,
    documentsUploadedThisWeek,
  ] = await Promise.all([
    ServiceMatter.countDocuments({ client: clientId, status: { $in: ACTIVE_MATTER_STATUSES } }),
    ServiceMatter.countDocuments({ client: clientId, actionRequired: true }),
    ComplianceItem.findOne({ client: clientId, status: { $ne: "completed" } }).sort({ dueAt: 1 }).lean(),
    ComplianceItem.countDocuments({ client: clientId, status: { $ne: "completed" } }),
    Appointment.countDocuments({ client: clientId, status: { $in: ["requested", "confirmed"] } }),
    Appointment.findOne({ client: clientId, scheduledAt: { $gte: now }, status: { $in: ["requested", "confirmed"] } })
      .sort({ scheduledAt: 1 })
      .lean(),
    Document.countDocuments({ client: clientId }),
    Document.countDocuments({ client: clientId, uploadedAt: { $gte: startOfWeek } }),
  ]);

  const nextComplianceDueInDays = nextCompliance
    ? Math.max(0, Math.ceil((new Date(nextCompliance.dueAt) - now) / (1000 * 60 * 60 * 24)))
    : null;

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        activeServices,
        servicesNeedingAction,
        upcomingCompliance,
        nextComplianceDueInDays,
        appointmentsBooked,
        nextAppointmentAt: nextAppointment?.scheduledAt || null,
        documentsCount,
        documentsUploadedThisWeek,
      },
      "Dashboard stats fetched successfully"
    )
  );
});

/**
 * GET /api/client/dashboard/activity
 */
export const getClientDashboardActivity = asyncHandler(async (req, res) => {
  const clientId = req.user._id;

  const [matters, appointments, documents] = await Promise.all([
    ServiceMatter.find({ client: clientId })
      .populate("service", "title")
      .sort({ updatedAt: -1 })
      .limit(10)
      .lean(),
    Appointment.find({ client: clientId }).sort({ updatedAt: -1 }).limit(10).lean(),
    Document.find({ client: clientId }).sort({ updatedAt: -1 }).limit(10).lean(),
  ]);

  const activity = [
    ...matters.map((m) => ({
      type: "service_matter",
      title: m.service?.title || m.serviceSnapshot?.title || "Service update",
      description: `Status: ${m.status}`,
      occurredAt: m.updatedAt,
    })),
    ...appointments.map((a) => ({
      type: "appointment",
      title: a.topic || "Appointment",
      description: `Status: ${a.status}`,
      occurredAt: a.updatedAt,
    })),
    ...documents.map((d) => ({
      type: "document",
      title: d.fileName,
      description: `Status: ${d.status}`,
      occurredAt: d.updatedAt,
    })),
  ]
    .sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt))
    .slice(0, 20);

  return res.status(200).json(
    new ApiResponse(200, activity, "Recent activity fetched successfully")
  );
});
