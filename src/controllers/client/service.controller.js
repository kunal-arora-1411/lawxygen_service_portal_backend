import Service from "../../models/service.model.js";

export const getAllServices = async (req, res) => {
  try {
    const {
      category,
      categorySlug,
      isActive,
      search,
      page = 1,
      limit = 300,
    } = req.query;

    const query = {};

    // Filter by category name
    if (category) {
      query.category = category;
    }

    // Filter by category slug
    if (categorySlug) {
      query.categorySlug = categorySlug;
    }

    // Filter active/inactive
    if (isActive !== undefined) {
      query.isActive = isActive === "true";
    }

    // Search
    if (search) {
      query.$or = [
        {
          title: {
            $regex: search,
            $options: "i",
          },
        },
        {
          category: {
            $regex: search,
            $options: "i",
          },
        },
        {
          summary: {
            $regex: search,
            $options: "i",
          },
        },
      ];
    }

    const pageNumber = Math.max(Number(page), 1);
    const limitNumber = Math.min(
      Math.max(Number(limit), 1),
      300
    );

    const skip = (pageNumber - 1) * limitNumber;

    const [services, total] = await Promise.all([
      Service.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNumber)
        .lean(),

      Service.countDocuments(query),
    ]);

    return res.status(200).json({
      success: true,
      data: services,
      pagination: {
        page: pageNumber,
        limit: limitNumber,
        total,
        totalPages: Math.ceil(total / limitNumber),
      },
    });
  } catch (error) {
    console.error("Get all services error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch services",
      error: error.message,
    });
  }
};

export const getServiceBySlug = async (req, res) => {
  try {
    const { slug } = req.params;

    const service = await Service.findOne({
      slug,
      isActive: true,
    }).lean();

    if (!service) {
      return res.status(404).json({
        success: false,
        message: "Service not found",
      });
    }

    return res.status(200).json({
      success: true,
      data: service,
    });
  } catch (error) {
    console.error("Get service by slug error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch service",
      error: error.message,
    });
  }
};

export const getServicesByCategory = async (req, res) => {
  try {
    const { categorySlug } = req.params;

    const services = await Service.find({
      categorySlug,
      isActive: true,
    })
      .sort({ title: 1 })
      .lean();

    return res.status(200).json({
      success: true,
      data: services,
    });
  } catch (error) {
    console.error("Get services by category error:", error);

    return res.status(500).json({
      success: false,
      message: "Failed to fetch category services",
      error: error.message,
    });
  }
};
