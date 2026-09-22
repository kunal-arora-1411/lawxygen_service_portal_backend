import { User } from "../../models/user.model.js";
import ServiceMatter from "../../models/serviceMatter.model.js";
import Service from "../../models/service.model.js";
import Appointment from "../../models/appointment.model.js";
import ComplianceItem from "../../models/compliance.model.js";
import Document from "../../models/document.model.js";
import SupportTicket from "../../models/supportTicket.model.js";
import ApiResponse from "../../utils/ApiResponse.js";
import asyncHandler from "../../utils/asyncHandler.js";

const ACTIVE_MATTER_STATUSES = ["PAID", "ASSIGNED", "IN_PROGRESS", "ACTION_REQUIRED", "UNDER_REVIEW"];
const WEEKDAY_LABELS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/**
 * GET /api/admin/dashboard/stats
 */
export const getAdminDashboardStats = asyncHandler(async (req, res) => {
  const now = new Date();

  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);

  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);

  const [
    registeredClients,
    newClientsThisWeek,
    activeRequests,
    unassignedRequests,
    appointmentsToday,
    upcomingAppointments,
    publishedServices,
    serviceCategories,
  ] = await Promise.all([
    User.countDocuments({ role: "user", isDeleted: false }),
    User.countDocuments({ role: "user", isDeleted: false, createdAt: { $gte: startOfWeek } }),
    ServiceMatter.countDocuments({ status: { $in: ACTIVE_MATTER_STATUSES } }),
    ServiceMatter.countDocuments({ professional: null, status: { $in: ACTIVE_MATTER_STATUSES } }),
    Appointment.countDocuments({ scheduledAt: { $gte: startOfToday, $lte: endOfToday } }),
    Appointment.countDocuments({ scheduledAt: { $gt: endOfToday }, status: { $in: ["requested", "confirmed"] } }),
    Service.countDocuments({ isActive: true }),
    Service.distinct("categorySlug"),
  ]);

  return res.status(200).json(
    new ApiResponse(
      200,
      {
        registeredClients,
        newClientsThisWeek,
        activeRequests,
        unassignedRequests,
        appointmentsToday,
        upcomingAppointments,
        publishedServices,
        serviceCategories: serviceCategories.length,
      },
      "Dashboard stats fetched successfully"
    )
  );
});

/**
 * GET /api/admin/dashboard/weekly-workload
 */
export const getWeeklyWorkload = asyncHandler(async (req, res) => {
  const now = new Date();

  const startOfWeek = new Date(now);
  startOfWeek.setDate(now.getDate() - now.getDay());
  startOfWeek.setHours(0, 0, 0, 0);

  const endOfWeek = new Date(startOfWeek);
  endOfWeek.setDate(startOfWeek.getDate() + 7);

  const matters = await ServiceMatter.find({
    updatedAt: { $gte: startOfWeek, $lt: endOfWeek },
  })
    .select("updatedAt")
    .lean();

  const counts = new Array(7).fill(0);

  matters.forEach((matter) => {
    counts[new Date(matter.updatedAt).getDay()] += 1;
  });

  const workload = WEEKDAY_LABELS.map((day, index) => ({ day, value: counts[index] }));

  return res.status(200).json(
    new ApiResponse(200, workload, "Weekly workload fetched successfully")
  );
});

/**
 * GET /api/admin/dashboard/needs-attention
 */
export const getNeedsAttention = asyncHandler(async (req, res) => {
  const [actionRequiredMatters, overdueCompliance] = await Promise.all([
    ServiceMatter.find({ actionRequired: true })
      .populate("client", "name")
      .populate("service", "title")
      .sort({ updatedAt: -1 })
      .limit(10)
      .lean(),
    ComplianceItem.find({ status: { $ne: "completed" }, dueAt: { $lt: new Date() } })
      .populate("client", "name")
      .sort({ dueAt: 1 })
      .limit(10)
      .lean(),
  ]);

  const items = [
    ...actionRequiredMatters.map((m) => ({
      title: `${m.client?.name || "Client"} — ${m.service?.title || m.serviceSnapshot?.title || "Service"}`,
      description: m.actionMessage || "Action required from client",
      dueAt: m.updatedAt,
    })),
    ...overdueCompliance.map((c) => ({
      title: `${c.client?.name || "Client"} — ${c.title}`,
      description: c.description || "Overdue compliance deadline",
      dueAt: c.dueAt,
    })),
  ].sort((a, b) => new Date(a.dueAt) - new Date(b.dueAt));

  return res.status(200).json(
    new ApiResponse(200, items, "Needs-attention items fetched successfully")
  );
});

/**
 * GET /api/admin/dashboard/activity
 */
export const getAdminDashboardActivity = asyncHandler(async (req, res) => {
  const [matters, appointments, tickets, documents] = await Promise.all([
    ServiceMatter.find()
      .populate("client", "name")
      .populate("service", "title")
      .sort({ updatedAt: -1 })
      .limit(10)
      .lean(),
    Appointment.find().populate("client", "name").sort({ updatedAt: -1 }).limit(10).lean(),
    SupportTicket.find().populate("client", "name").sort({ updatedAt: -1 }).limit(10).lean(),
    Document.find().populate("client", "name").sort({ updatedAt: -1 }).limit(10).lean(),
  ]);

  const activity = [
    ...matters.map((m) => ({
      type: "service_matter",
      title: `${m.client?.name || "Client"} — ${m.service?.title || m.serviceSnapshot?.title || "Service"}`,
      description: `Status: ${m.status}`,
      occurredAt: m.updatedAt,
    })),
    ...appointments.map((a) => ({
      type: "appointment",
      title: `${a.client?.name || "Client"} — ${a.topic || "Appointment"}`,
      description: `Status: ${a.status}`,
      occurredAt: a.updatedAt,
    })),
    ...tickets.map((t) => ({
      type: "support_ticket",
      title: `${t.client?.name || "Client"} — ${t.subject}`,
      description: `Status: ${t.status}`,
      occurredAt: t.updatedAt,
    })),
    ...documents.map((d) => ({
      type: "document",
      title: `${d.client?.name || "Client"} — ${d.fileName}`,
      description: `Status: ${d.status}`,
      occurredAt: d.updatedAt,
    })),
  ]
    .sort((a, b) => new Date(b.occurredAt) - new Date(a.occurredAt))
    .slice(0, 20);

  return res.status(200).json(
    new ApiResponse(200, activity, "Platform activity fetched successfully")
  );
});
