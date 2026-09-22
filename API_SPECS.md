# LAWXYGEN — Backend API Requirements

This document lists every API route the frontend needs to replace hardcoded dashboard/admin data with live data. Frontend integration will be done separately — this is the contract the backend should implement against.

## Conventions (already established — keep consistent)

- **Base URL**: frontend calls relative to `VITE_API_BASE_URL` (currently `http://localhost:3000`).
- **Auth**: cookie-based session (`withCredentials: true`), with a refresh-token flow already in place for the client side (`POST /api/client/auth/refresh-token`, triggered automatically on a 401). Admin needs the equivalent — see [Admin Auth](#0-admin-auth-new).
- **Response envelope** — every response, success or error, must use this shape:
  ```json
  {
    "statusCode": 200,
    "success": true,
    "message": "OK",
    "data": { }
  }
  ```
- **Path prefix**: client-facing routes live under `/api/client/...`, admin routes under `/api/admin/...`.
- **Dates**: ISO 8601 strings (`createdAt`, `updatedAt`, etc.), not pre-formatted display strings. Formatting ("2h ago", "23 Aug") happens on the frontend.
- **Status fields**: return clean machine-readable enums (e.g. `"in_progress"`, `"awaiting_documents"`, `"resolved"`), not display labels or UI color hints ("tone"). The frontend maps enum → label/color. Don't invent a `tone` field on the backend.
- **IDs**: Mongo-style `_id` strings, matching the existing `ServiceMatterRecord`/`ServiceRecord` pattern.
- **Pagination**: any list endpoint expected to grow unbounded (users, requests, support tickets, appointments) should accept `?page=&limit=` and return `{ items: [...], total, page, limit }` inside `data`.

---

## Already built (for reference/consistency — do not change)

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/api/client/auth/google` | Google sign-in |
| POST | `/api/client/auth/facebook` | Facebook sign-in |
| POST | `/api/client/auth/email` | Email/password or email+OTP sign-in |
| POST | `/api/client/auth/phone/send-otp` | Send phone OTP |
| POST | `/api/client/auth/phone/verify-otp` | Verify phone OTP |
| POST | `/api/client/auth/refresh-token` | Refresh session |
| POST | `/api/client/auth/logout` | Logout |
| GET | `/api/client/users/me` | Current client profile |
| GET | `/api/client/services` | Full service catalogue |
| GET | `/api/client/services/slug/:slug` | Single service by slug |
| GET | `/api/client/services/category/:categorySlug` | Services in a category |
| POST | `/api/client/serviceMatter` | Create a service matter (client purchases/starts a service) |
| GET | `/api/client/serviceMatter` | List the current client's service matters |

`ServiceMatterRecord` shape (already live — reuse this pattern for every new entity below):
```ts
{
  _id: string,
  client: string,
  service: { _id, title, slug, category, categorySlug, accent, summary, price } | null,
  serviceSnapshot: { title, slug, price },
  professional: string | null,
  assignedBy: string | null,
  status: string,
  progress: number,        // 0-100
  currentStep: number,
  totalSteps: number,
  currentStepTitle: string,
  actionRequired: boolean,
  actionMessage: string | null,
  assignedAt, startedAt, completedAt, createdAt, updatedAt: string (ISO)
}
```

---

## New routes needed

### 0. Admin auth (new)

There is currently **no admin login/session mechanism at all**. Needed:

| Method | Endpoint | Body | Notes |
|---|---|---|---|
| POST | `/api/admin/auth/login` | `{ email, password }` | Sets admin session cookie |
| POST | `/api/admin/auth/logout` | — | |
| POST | `/api/admin/auth/refresh-token` | — | Same pattern as client refresh |
| GET | `/api/admin/me` | — | Returns logged-in admin's identity (name, role) — used for the sidebar avatar/profile label, currently hardcoded to `"A" / "Admin workspace"` |

`AdminUser` shape:
```ts
{ _id, name, email, role: "super_admin" | "admin" | "professional", createdAt }
```

---

### 1. Service requests (admin view of service matters)

No new entity — this is `ServiceMatterRecord` viewed without a client filter, plus a couple of admin-only fields/actions.

| Method | Endpoint | Body | Notes |
|---|---|---|---|
| GET | `/api/admin/service-matters` | query: `status?, unassigned?, page, limit` | All clients' matters, for the "Service requests" queue |
| GET | `/api/admin/service-matters/:id` | — | Single matter detail |
| PATCH | `/api/admin/service-matters/:id` | `{ status?, professional?, actionRequired?, actionMessage? }` | Assign a professional, change status, flag action needed |
| GET | `/api/admin/service-matters/stats` | — | `{ active, unassigned, dueToday, withinSlaPercent }` — powers the "Service requests" metrics row |

---

### 2. Appointments

`Appointment` shape:
```ts
{
  _id: string,
  client: { _id, name } ,
  serviceMatter: string | null,       // optional link to a matter
  professional: { _id, name } | null,
  scheduledAt: string,                // ISO datetime — replaces separate date/time strings
  durationMinutes: number,
  mode: "video" | "phone" | "in_person",
  topic: string,
  status: "requested" | "confirmed" | "completed" | "missed" | "cancelled",
  joinUrl: string | null,
  createdAt: string, updatedAt: string
}
```

| Method | Endpoint | Body | Notes |
|---|---|---|---|
| GET | `/api/client/appointments` | query: `status?, upcoming?` | Current client's appointments |
| POST | `/api/client/appointments` | `{ serviceMatter?, scheduledAt, durationMinutes, mode, topic }` | Client books a slot |
| PATCH | `/api/client/appointments/:id` | `{ scheduledAt? }` or `{ status: "cancelled" }` | Reschedule / cancel |
| GET | `/api/client/appointments/stats` | — | `{ upcoming, video, completed, missed }` |
| GET | `/api/admin/appointments` | query: `status?, date?, page, limit` | All clients' appointments |
| PATCH | `/api/admin/appointments/:id` | `{ status?, professional?, scheduledAt? }` | Confirm, reassign, reschedule |
| GET | `/api/admin/appointments/stats` | — | `{ today, upcoming, pending, professionalsAvailable }` |

---

### 3. Documents

`Document` shape:
```ts
{
  _id: string,
  client: string,
  serviceMatter: { _id, title } | null,
  fileName: string,
  fileUrl: string,
  mimeType: string,
  sizeBytes: number,
  status: "uploaded" | "in_review" | "verified" | "rejected",
  reviewNote: string | null,
  uploadedAt: string, reviewedAt: string | null
}
```

| Method | Endpoint | Body | Notes |
|---|---|---|---|
| GET | `/api/client/documents` | query: `status?, serviceMatter?` | Client's document vault |
| POST | `/api/client/documents` | multipart: `file`, `serviceMatter?` | Upload |
| DELETE | `/api/client/documents/:id` | — | Only if not yet verified |
| GET | `/api/client/documents/stats` | — | `{ total, verified, inReview, actionNeeded }` |
| GET | `/api/admin/documents` | query: `status?, client?, page, limit` | Review queue across clients |
| PATCH | `/api/admin/documents/:id` | `{ status, reviewNote? }` | Verify / reject |

---

### 4. Compliance deadlines

Not client-created — generated by the backend (e.g. when a service matter reaches a filing step) or seeded by an admin/professional working the case.

`ComplianceItem` shape:
```ts
{
  _id: string,
  client: string,
  serviceMatter: { _id, title } | null,
  title: string,                       // e.g. "GSTR-3B filing"
  description: string,                 // e.g. "July return period"
  dueAt: string,                       // ISO date
  status: "upcoming" | "due_soon" | "completed" | "overdue",
  completedAt: string | null,
  createdAt: string
}
```

| Method | Endpoint | Body | Notes |
|---|---|---|---|
| GET | `/api/client/compliance` | query: `status?` | Client's compliance calendar |
| GET | `/api/client/compliance/stats` | — | `{ upcoming, dueSoon, completed, overdue }` |
| POST | `/api/admin/compliance` | `{ client, serviceMatter?, title, description, dueAt }` | Admin/professional creates a deadline for a client |
| PATCH | `/api/admin/compliance/:id` | `{ status?, dueAt? }` | Mark complete / reschedule |
| GET | `/api/admin/compliance` | query: `client?, status?, page, limit` | Cross-client view |

---

### 5. Messages / conversations

`Conversation` shape:
```ts
{
  _id: string,
  client: string,
  participants: { _id, name, role }[],   // assigned professional(s)/support
  subject: string,                       // e.g. "Company Registration Team"
  lastMessage: { body, senderId, sentAt } | null,
  unreadCount: number,
  createdAt: string
}
```

`Message` shape:
```ts
{ _id, conversation: string, sender: { _id, name, role }, body: string, attachments: string[], sentAt: string }
```

| Method | Endpoint | Body | Notes |
|---|---|---|---|
| GET | `/api/client/conversations` | — | List, sorted by last activity |
| GET | `/api/client/conversations/:id/messages` | query: `before?, limit` | Message history |
| POST | `/api/client/conversations/:id/messages` | `{ body, attachments? }` | Send a message |
| POST | `/api/client/conversations/:id/read` | — | Mark read, resets `unreadCount` |
| GET | `/api/client/conversations/stats` | — | `{ unread, conversations, experts, updatedToday }` |
| GET | `/api/admin/conversations` | query: `unread?, page, limit` | Support/professional inbox across clients |
| POST | `/api/admin/conversations/:id/messages` | `{ body, attachments? }` | Reply as admin/professional |

---

### 6. Support tickets

`SupportTicket` shape:
```ts
{
  _id: string,
  client: string,
  serviceMatter: { _id, title } | null,
  subject: string,                     // e.g. "Callback request"
  language: string | null,
  status: "waiting" | "in_progress" | "resolved",
  waitStartedAt: string,
  resolvedAt: string | null,
  createdAt: string
}
```

| Method | Endpoint | Body | Notes |
|---|---|---|---|
| POST | `/api/client/support/tickets` | `{ subject, serviceMatter?, language? }` | Client raises a ticket |
| GET | `/api/client/support/tickets` | — | Client's own tickets |
| GET | `/api/admin/support/tickets` | query: `status?, page, limit` | Support queue |
| PATCH | `/api/admin/support/tickets/:id` | `{ status }` | Claim / resolve |
| GET | `/api/admin/support/stats` | — | `{ waiting, inProgress, resolvedToday, avgResponseMinutes }` |

---

### 7. Users (admin — client directory)

| Method | Endpoint | Body | Notes |
|---|---|---|---|
| GET | `/api/admin/users` | query: `search?, page, limit` | Client list — name, active matter count, location, join date, status |
| GET | `/api/admin/users/:id` | — | Single client detail (matters, documents, appointments summary) |
| GET | `/api/admin/users/stats` | — | `{ registered, newThisMonth, activeMatters, verifiedPercent }` |

`AdminUserListItem` shape:
```ts
{ _id, name, location: string | null, activeMattersCount: number, joinedAt: string, status: "active" | "inactive", verified: boolean }
```

---

### 8. Professionals (admin)

`Professional` shape:
```ts
{
  _id: string,
  name: string,
  role: string,                        // e.g. "Corporate Legal Expert"
  specialties: string[],
  languages: string[],
  availability: "online" | "in_call" | "offline",
  activeMattersCount: number,
  createdAt: string
}
```

| Method | Endpoint | Body | Notes |
|---|---|---|---|
| GET | `/api/admin/professionals` | query: `availability?, page, limit` | |
| POST | `/api/admin/professionals` | `{ name, role, specialties, languages }` | |
| PATCH | `/api/admin/professionals/:id` | `{ availability?, specialties?, languages? }` | |
| GET | `/api/admin/professionals/stats` | — | `{ total, online, inCall, offline }` |

---

### 9. Service catalogue management (admin)

Read side already exists (`GET /api/client/services`). Admin needs write access over the same `ServiceRecord` entity:

| Method | Endpoint | Body | Notes |
|---|---|---|---|
| GET | `/api/admin/services` | query: `category?, page, limit` | Same records as client catalogue, admin-scoped list view |
| POST | `/api/admin/services` | full `ServiceRecord` minus `_id` | Create a new service page |
| PATCH | `/api/admin/services/:id` | partial `ServiceRecord` | Edit |
| PATCH | `/api/admin/services/:id/publish` | `{ isActive: boolean }` | Publish/unpublish |
| GET | `/api/admin/services/stats` | — | `{ totalPages, categories, published, brokenLinks }` |

---

### 10. Dashboard aggregate stats

One call each to populate the top stat-card rows without four separate round trips:

| Method | Endpoint | Response |
|---|---|---|
| GET | `/api/client/dashboard/stats` | `{ activeServices, servicesNeedingAction, upcomingCompliance, nextComplianceDueInDays, appointmentsBooked, nextAppointmentAt, documentsCount, documentsUploadedThisWeek }` |
| GET | `/api/admin/dashboard/stats` | `{ registeredClients, newClientsThisWeek, activeRequests, unassignedRequests, appointmentsToday, upcomingAppointments, publishedServices, serviceCategories }` |
| GET | `/api/admin/dashboard/weekly-workload` | `[{ day: "Mon", value: number }, ...]` — feeds the workload bar chart |
| GET | `/api/admin/dashboard/needs-attention` | `[{ title, description, dueAt }]` |
| GET | `/api/admin/dashboard/activity` | `[{ type, title, description, occurredAt }]` — replaces the "Platform pulse" mock feed |
| GET | `/api/client/dashboard/activity` | `[{ type, title, description, occurredAt }]` — replaces "Recent activity" mock feed |

### 11. Sidebar badge counts

The nav badges in `PortalShell` (`Service requests: 18`, `Appointments: 7`, `Support queue: 5`, `My services: 3`, `Compliance: 2`, `Messages: 4`) should be derived from the stats/list endpoints above rather than being their own route — e.g. `service-matters/stats.unassigned`, `appointments/stats.today`, `support/stats.waiting`, `compliance/stats.upcoming`, `conversations/stats.unread`. No dedicated badge endpoint needed if the stats responses above cover these fields.

---

## Not covered here

- **Settings** (`/admin/settings`) — mostly configuration (roles, alert channels, security toggles) rather than list data. Recommend scoping this after the rest, as `GET/PATCH /api/admin/settings` once the actual configurable fields are decided.
- **Profile tab** (`/dashboard/profile`) — largely covered by extending `GET/PATCH /api/client/users/me` (business info, sign-in methods, preferences) rather than a new entity; worth a short separate spec once the exact editable fields are confirmed.
