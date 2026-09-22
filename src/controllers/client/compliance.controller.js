import ComplianceItem from "../../models/compliance.model.js";
import ApiResponse from "../../utils/ApiResponse.js";
import asyncHandler from "../../utils/asyncHandler.js";

const DUE_SOON_WINDOW_DAYS = 7;

const deriveStatus = (item) => {
  if (item.status === "completed") {
    return "completed";
  }

  const now = new Date();
  const dueAt = new Date(item.dueAt);
  const diffDays = (dueAt - now) / (1000 * 60 * 60 * 24);

  if (diffDays < 0) {
    return "overdue";
  }

  if (diffDays <= DUE_SOON_WINDOW_DAYS) {
    return "due_soon";
  }

  return "upcoming";
};

/**
 * GET /api/client/compliance
 * query: status?
 */
export const listMyCompliance = asyncHandler(async (req, res) => {
  const { status } = req.query;

  const items = await ComplianceItem.find({ client: req.user._id })
    .populate("serviceMatter", "serviceSnapshot")
    .sort({ dueAt: 1 })
    .lean();

  const withDerivedStatus = items.map((item) => ({ ...item, status: deriveStatus(item) }));

  const filtered = status
    ? withDerivedStatus.filter((item) => item.status === status)
    : withDerivedStatus;

  return res.status(200).json(
    new ApiResponse(200, filtered, "Compliance items fetched successfully")
  );
});

/**
 * GET /api/client/compliance/stats
 */
export const getMyComplianceStats = asyncHandler(async (req, res) => {
  const items = await ComplianceItem.find({ client: req.user._id }).lean();

  const stats = items.reduce(
    (acc, item) => {
      const status = deriveStatus(item);
      acc[status] = (acc[status] || 0) + 1;
      return acc;
    },
    { upcoming: 0, due_soon: 0, completed: 0, overdue: 0 }
  );

  return res.status(200).json(
    new ApiResponse(
      200,
      { upcoming: stats.upcoming, dueSoon: stats.due_soon, completed: stats.completed, overdue: stats.overdue },
      "Compliance stats fetched successfully"
    )
  );
});
