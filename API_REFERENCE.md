# LAWXYGEN Backend — API Reference (Implemented)

This documents every route currently implemented in the backend, with exact paths, payloads, and response shapes, for frontend integration. It supersedes `API_SPECS.md` as the source of truth for what's actually live.

## Conventions

- **Base URL**: `http://localhost:3000` (or `VITE_API_BASE_URL`).
- **Auth**: cookie-based session. `POST` login/OTP-verify endpoints set `accessToken` (15 min) and `refreshToken` (7 days) as `httpOnly` cookies. Send `withCredentials: true` / `credentials: "include"` on every request. On a `401`, call the matching `refresh-token` endpoint, then retry.
- **Response envelope** (all responses, success or error):
  ```json
  { "statusCode": 200, "success": true, "message": "OK", "data": {} }
  ```
  Errors use the same shape with `success: false` and `data: null`.
- **Pagination**: list endpoints that accept `page`/`limit` return `{ items: [...], total, page, limit }` inside `data`. A few older list endpoints (client's own service/matter lists, which don't grow per-user) just return an array in `data` — noted per-endpoint below.
- **IDs**: Mongo `_id` strings.
- **Roles**: `User.role` is one of `user` (client), `professional`, `admin`, `super_admin`. Admin-only routes require `admin` or `super_admin`. Professional-only routes require `professional`.

---

## 0. Client auth — `/api/client/auth`

| Method | Endpoint | Body | Notes |
|---|---|---|---|
| POST | `/email` | `{ email, password }` | Login if the email exists, otherwise registers a new account. Sets no cookies — returns `accessToken`/`refreshToken` in `data` (frontend stores/sends as needed; client OTP/social flows set cookies directly, see below). |
| POST | `/phone/send-otp` | `{ phone }` | Creates the user if new, (re)generates a 6-digit OTP, 5 min expiry. |
| POST | `/phone/verify-otp` | `{ phone, otp }` | Returns `{ user, accessToken, refreshToken, isNewUser }`. |
| POST | `/google` | `{ credential }` | Google ID token from GIS. Sets `accessToken`/`refreshToken` cookies. |
| POST | `/facebook` | `{ accessToken }` | Facebook access token from the FB SDK. Sets cookies. |
| POST | `/refresh-token` | — (reads `refreshToken` cookie, or `{ refreshToken }` in body as fallback) | Returns new `{ accessToken, refreshToken }`. |
| POST | `/logout` | — | **Auth required.** Clears refresh token server-side. |

`data.user` / `data.admin` shape (safe fields only):
```ts
{
  _id, name, email, phone, role, isVerified, isActive, location,
  profileCompleted, profileImage, professionalProfile, lastLoginAt,
  createdAt, updatedAt
}
```

---

## 1. Client users — `/api/client/users` (auth required)

| Method | Endpoint | Body | Notes |
|---|---|---|---|
| GET | `/me` | — | Current user profile. |
| PATCH | `/me` | `{ name?, phone?, profileImage? }` | Partial update. |
| PATCH | `/me/password` | `{ currentPassword, newPassword }` | Clears session cookies on success — re-login required. |
| DELETE | `/me` | — | Soft delete (`isDeleted: true`). Clears cookies. |

---

## 2. Client services (catalogue, read-only) — `/api/client/services`

| Method | Endpoint | Query | Notes |
|---|---|---|---|
| GET | `/` | `category?, categorySlug?, isActive?, search?, page?, limit?` | `data`: `{ services... }` array; pagination under top-level `pagination` key (not `data.items` — this one predates the new convention): `{ success, data: [...], pagination: { page, limit, total, totalPages } }`. |
| GET | `/category/:categorySlug` | — | `data`: array of services. |
| GET | `/slug/:slug` | — | `data`: single service object. |

`Service` shape: see `Service` model — `title, slug, category, categorySlug, accent, variant, archetype, summary, highlights[], checklist[][], overview[], benefits[][], documents[][], process[][], faqs[][], related[{title,href}], cta, note, bg, soft, price, isActive`.

---

## 3. Client service matters — `/api/client/serviceMatter` (auth required)

Same response-shape convention as above (`pagination` key, not `data.items`) since this predates the newer endpoints.

| Method | Endpoint | Body | Notes |
|---|---|---|---|
| POST | `/` | `{ serviceId }` | Creates a matter for the logged-in client. Currently auto-marks `status: "PAID"` (Razorpay not wired yet). `409` if an active matter for that service already exists. |
| GET | `/` | — | `data`: array of the client's matters, populated `service` + `professional`. |
| GET | `/:matterId` | — | `data`: single matter. |
| PATCH | `/:matterId/action/resolve` | — | Clears `actionRequired`/`actionMessage`, moves status back to `IN_PROGRESS` (if assigned) or `PAID`. |

`ServiceMatter` shape:
```ts
{
  _id, client, service: {_id,title,slug,category,categorySlug,accent,summary,price} | null,
  serviceSnapshot: { title, slug, price },
  professional: {_id,name,email,phone} | null,
  assignedBy, status: "PAYMENT_PENDING"|"PAID"|"ASSIGNED"|"IN_PROGRESS"|"ACTION_REQUIRED"|"UNDER_REVIEW"|"COMPLETED"|"CANCELLED",
  progress, currentStep, totalSteps, currentStepTitle,
  actionRequired, actionMessage,
  assignedAt, startedAt, completedAt, createdAt, updatedAt
}
```

---

## 4. Client appointments — `/api/client/appointments` (auth required)

| Method | Endpoint | Body / Query | Notes |
|---|---|---|---|
| GET | `/stats` | — | `data: { upcoming, video, completed, missed }` |
| GET | `/` | query: `status?, upcoming?` | `data`: array, populated `professional.name`. `upcoming=true` filters to future + `requested`/`confirmed`. |
| POST | `/` | `{ serviceMatter?, scheduledAt, durationMinutes, mode, topic }` | `scheduledAt` is ISO datetime. `mode`: `video`\|`phone`\|`in_person`. Status starts `requested`. |
| PATCH | `/:id` | `{ scheduledAt? }` **or** `{ status: "cancelled" }` | Clients may only reschedule or cancel — any other `status` value is rejected (`400`). Rescheduling resets status to `requested`. |

`Appointment` shape:
```ts
{ _id, client, serviceMatter, professional, scheduledAt, durationMinutes, mode, topic,
  status: "requested"|"confirmed"|"completed"|"missed"|"cancelled", joinUrl, createdAt, updatedAt }
```

---

## 5. Client documents — `/api/client/documents` (auth required)

| Method | Endpoint | Body / Query | Notes |
|---|---|---|---|
| GET | `/stats` | — | `data: { total, verified, inReview, actionNeeded }` |
| GET | `/` | query: `status?, serviceMatter?` | `data`: array. |
| POST | `/` | **multipart/form-data**: field `file` (required), field `serviceMatter` (optional string ID) | 20MB max. Stored on disk under `/uploads/documents/…`; `fileUrl` in the response is a relative path (`/uploads/documents/xxx.pdf`) — prefix with the API base URL to load it. |
| DELETE | `/:id` | — | `400` if the document's `status` is already `verified`. |

`Document` shape:
```ts
{ _id, client, serviceMatter, fileName, fileUrl, mimeType, sizeBytes,
  status: "uploaded"|"in_review"|"verified"|"rejected", reviewNote, uploadedAt, reviewedAt }
```

Frontend upload example:
```js
const form = new FormData();
form.append("file", fileInput.files[0]);
if (serviceMatterId) form.append("serviceMatter", serviceMatterId);
await axios.post("/api/client/documents", form, { withCredentials: true });
```

---

## 6. Client compliance — `/api/client/compliance` (auth required)

| Method | Endpoint | Query | Notes |
|---|---|---|---|
| GET | `/stats` | — | `data: { upcoming, dueSoon, completed, overdue }` |
| GET | `/` | `status?` (`upcoming`\|`due_soon`\|`completed`\|`overdue`) | `status` is **derived at read time** from `dueAt` (not a client-editable field) — `overdue` if past due, `due_soon` if due within 7 days, else `upcoming`, unless admin marked it `completed`. |

`ComplianceItem` shape:
```ts
{ _id, client, serviceMatter, title, description, dueAt,
  status: "upcoming"|"due_soon"|"completed"|"overdue", completedAt, createdAt }
```

---

## 7. Client conversations / messages — `/api/client/conversations` (auth required)

| Method | Endpoint | Body / Query | Notes |
|---|---|---|---|
| GET | `/stats` | — | `data: { unread, conversations, experts, updatedToday }` |
| GET | `/` | — | List, sorted by last activity, populated `participants` + `lastMessage.senderId`. |
| GET | `/:id/messages` | query: `before?` (ISO datetime), `limit?` (default 50, max 100) | Returns oldest→newest. |
| POST | `/:id/messages` | `{ body, attachments?: string[] }` | Appends message, updates `lastMessage` on the conversation. |
| POST | `/:id/read` | — | Resets `unreadCount` to 0. |

`Conversation` shape:
```ts
{ _id, client, participants: [{_id,name,role}], subject,
  lastMessage: {body, senderId, sentAt} | null, unreadCount, createdAt, updatedAt }
```
`Message` shape:
```ts
{ _id, conversation, sender: {_id,name,role}, body, attachments: string[], sentAt }
```

> Note: there is no client-facing "create conversation" endpoint — conversations are expected to already exist (created when a professional/support thread is set up). If your frontend needs to let a client start a brand-new thread from scratch, flag it and we'll add a creation endpoint.

---

## 8. Client support tickets — `/api/client/support` (auth required)

| Method | Endpoint | Body | Notes |
|---|---|---|---|
| GET | `/tickets` | — | Client's own tickets. |
| POST | `/tickets` | `{ subject, serviceMatter?, language? }` | Starts at `status: "waiting"`. |

`SupportTicket` shape:
```ts
{ _id, client, serviceMatter, subject, language, status: "waiting"|"in_progress"|"resolved",
  waitStartedAt, resolvedAt, createdAt }
```

---

## 9. Client dashboard — `/api/client/dashboard` (auth required)

| Method | Endpoint | Response `data` |
|---|---|---|
| GET | `/stats` | `{ activeServices, servicesNeedingAction, upcomingCompliance, nextComplianceDueInDays, appointmentsBooked, nextAppointmentAt, documentsCount, documentsUploadedThisWeek }` |
| GET | `/activity` | `[{ type, title, description, occurredAt }]` — merged feed from service matters, appointments, and documents (last 20, newest first). `type` is one of `service_matter`\|`appointment`\|`document`. |

---

## 10. Admin auth — `/api/admin/auth` + `/api/admin/me`

There is **no admin signup endpoint**. The first admin is created via `npm run seed:admin` (reads `SEED_ADMIN_NAME`/`SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD` from `.env`).

| Method | Endpoint | Body | Notes |
|---|---|---|---|
| POST | `/api/admin/auth/login` | `{ email, password }` | Only succeeds for `role: admin` or `super_admin`. Sets `accessToken`/`refreshToken` cookies. |
| POST | `/api/admin/auth/refresh-token` | — | Same pattern as client. |
| POST | `/api/admin/auth/logout` | — | Auth + admin role required. |
| GET | `/api/admin/me` | — | Auth + admin role required. Returns the logged-in admin's full profile (for sidebar name/role). |

---

## 11. Admin — service requests — `/api/admin/service-matters` (admin auth required)

| Method | Endpoint | Body / Query | Notes |
|---|---|---|---|
| GET | `/stats` | — | `data: { active, unassigned, dueToday, withinSlaPercent }` |
| GET | `/` | `status?, unassigned? ("true"), page?, limit?` | `data: { items, total, page, limit }` |
| GET | `/:id` | — | Single matter, fully populated. |
| PATCH | `/:id` | `{ status?, professional?: string|null, actionRequired?, actionMessage? }` | Single unified update. Setting `professional` to a valid professional's `_id` auto-assigns and bumps `PAID`/`PAYMENT_PENDING` → `ASSIGNED`. Setting `professional: null` unassigns. `actionRequired: true` also sets `status: "ACTION_REQUIRED"`. |

---

## 12. Admin — appointments — `/api/admin/appointments` (admin auth required)

| Method | Endpoint | Body / Query | Notes |
|---|---|---|---|
| GET | `/stats` | — | `data: { today, upcoming, pending, professionalsAvailable }` |
| GET | `/` | `status?, date? (YYYY-MM-DD), page?, limit?` | `data: { items, total, page, limit }` |
| PATCH | `/:id` | `{ status?, professional?: string|null, scheduledAt? }` | Admin may set any status (`requested`\|`confirmed`\|`completed`\|`missed`\|`cancelled`). |

---

## 13. Admin — documents — `/api/admin/documents` (admin auth required)

| Method | Endpoint | Body / Query | Notes |
|---|---|---|---|
| GET | `/` | `status?, client?, page?, limit?` | `data: { items, total, page, limit }`, populated `client.name/email`. |
| PATCH | `/:id` | `{ status, reviewNote? }` | `status` required, one of `uploaded`\|`in_review`\|`verified`\|`rejected`. Sets `reviewedAt` on `verified`/`rejected`. |

---

## 14. Admin — compliance — `/api/admin/compliance` (admin auth required)

| Method | Endpoint | Body / Query | Notes |
|---|---|---|---|
| GET | `/` | `client?, status?, page?, limit?` | `data: { items, total, page, limit }` |
| POST | `/` | `{ client, serviceMatter?, title, description, dueAt }` | `client` must be an existing `role: user` account. |
| PATCH | `/:id` | `{ status?, dueAt? }` | Manually overriding `status` here is a literal value (not re-derived); use `completed` to mark done. |

---

## 15. Admin — conversations — `/api/admin/conversations` (admin auth required)

| Method | Endpoint | Body / Query | Notes |
|---|---|---|---|
| GET | `/` | `unread? ("true"), page?, limit?` | `unread=true` returns conversations whose latest message is from the client (i.e. awaiting a staff reply). `data: { items, total, page, limit }` |
| POST | `/:id/messages` | `{ body, attachments? }` | Replies as the logged-in admin; auto-adds them to `participants` if not already present; increments the conversation's `unreadCount` (badge for the client). |

---

## 16. Admin — support tickets — `/api/admin/support` (admin auth required)

| Method | Endpoint | Body / Query | Notes |
|---|---|---|---|
| GET | `/stats` | — | `data: { waiting, inProgress, resolvedToday, avgResponseMinutes }` |
| GET | `/tickets` | `status?, page?, limit?` | `data: { items, total, page, limit }` |
| PATCH | `/tickets/:id` | `{ status }` | One of `waiting`\|`in_progress`\|`resolved`. Sets `resolvedAt` on `resolved`. |

---

## 17. Admin — users (client directory) — `/api/admin/users` (admin auth required)

| Method | Endpoint | Query | Notes |
|---|---|---|---|
| GET | `/stats` | — | `data: { registered, newThisMonth, activeMatters, verifiedPercent }` |
| GET | `/` | `search?, page?, limit?` | Clients only (`role: "user"`). `data: { items, total, page, limit }`. `search` matches name/email/phone (case-insensitive). |
| GET | `/all` | `search?, role? ("user"\|"professional"), page?, limit?` | Every `User` document **except** `admin`/`super_admin` accounts (i.e. excludes the seeded admin and any other staff logins). Use `role` to narrow to just clients or just professionals. `data: { items, total, page, limit }`. |
| GET | `/:id` | — | Client only (`role: "user"`). `data`: full user profile (minus password/tokens) + `matters` (last 10) + `matterCount`. |

`AdminUserListItem` shape (from the `/` list):
```ts
{ _id, name, location, activeMattersCount, joinedAt, status: "active"|"inactive", verified }
```

`/all` list item shape (raw, unlike `/`'s reshaped item):
```ts
{ _id, name, email, phone, role: "user"|"professional", location, isVerified, isActive, professionalProfile, createdAt }
```

---

## 18. Admin — professionals — `/api/admin/professionals` (admin auth required)

Backed by `User` accounts with `role: "professional"`; `professionalProfile.title` maps to this shape's `role` field (job title, e.g. "Corporate Legal Expert" — distinct from the account `role`).

| Method | Endpoint | Body / Query | Notes |
|---|---|---|---|
| GET | `/stats` | — | `data: { total, online, inCall, offline }` |
| GET | `/` | `availability?, page?, limit?` | `data: { items, total, page, limit }` |
| POST | `/` | `{ name, role, specialties: string[], languages: string[], email?, phone? }` | Creates a `professional` account (no password set yet — that's a separate invite/reset flow, not yet built). |
| PATCH | `/:id` | `{ availability?, specialties?, languages?, role? }` | `availability`: `online`\|`in_call`\|`offline`. |

`Professional` shape:
```ts
{ _id, name, role, specialties: string[], languages: string[],
  availability: "online"|"in_call"|"offline", activeMattersCount, createdAt }
```

---

## 19. Admin — service catalogue — `/api/admin/services` (admin auth required)

| Method | Endpoint | Body / Query | Notes |
|---|---|---|---|
| GET | `/stats` | — | `data: { totalPages, categories, published, brokenLinks }`. `brokenLinks` is always `0` for now (no link-checker implemented). |
| GET | `/` | `category?, page?, limit?` | `data: { items, total, page, limit }` |
| POST | `/` | Full `Service` body (see §2 shape) minus `_id` | `409` if `slug` already exists. |
| PATCH | `/:id` | Partial `Service` body | `409` on slug collision. |
| PATCH | `/:id/publish` | `{ isActive: boolean }` | |

---

## 20. Admin — dashboard — `/api/admin/dashboard` (admin auth required)

| Method | Endpoint | Response `data` |
|---|---|---|
| GET | `/stats` | `{ registeredClients, newClientsThisWeek, activeRequests, unassignedRequests, appointmentsToday, upcomingAppointments, publishedServices, serviceCategories }` |
| GET | `/weekly-workload` | `[{ day: "Sun"..."Sat", value: number }]` — count of service matters updated per weekday, current week. |
| GET | `/needs-attention` | `[{ title, description, dueAt }]` — merges matters with `actionRequired: true` and overdue compliance items, sorted soonest-first. |
| GET | `/activity` | `[{ type, title, description, occurredAt }]` — merged feed across service matters, appointments, support tickets, documents (last 20). `type`: `service_matter`\|`appointment`\|`support_ticket`\|`document`. |

---

## 21. Sidebar badge counts

No dedicated endpoint — derive from the stats calls you're already loading:

| Badge | Source |
|---|---|
| Service requests | `GET /api/admin/service-matters/stats` → `unassigned` |
| Appointments | `GET /api/admin/appointments/stats` → `today` |
| Support queue | `GET /api/admin/support/stats` → `waiting` |
| Compliance | `GET /api/admin/compliance` (or client's `/compliance/stats`) → `upcoming` |
| Messages | `GET /api/admin/conversations?unread=true` (count) or client's `/conversations/stats` → `unread` |

---

## 22. Professional portal (bonus — not in original spec, built for forward compatibility)

Mounted at `/api/professional/service-matters`, requires `role: "professional"`. Not currently wired to any frontend — included since the underlying logic already existed and the folder structure now supports it.

| Method | Endpoint | Body | Notes |
|---|---|---|---|
| GET | `/` | query: `status?, page?, limit?` | `data: { matters... }` array (old-style `pagination` key, not `data.items`). |
| GET | `/:matterId` | — | |
| PATCH | `/:matterId/progress` | `{ progress?, currentStep?, currentStepTitle? }` | Auto-moves `ASSIGNED`→`IN_PROGRESS`; `progress: 100` moves to `UNDER_REVIEW`. |
| PATCH | `/:matterId/action` | `{ actionMessage }` | Sets `status: "ACTION_REQUIRED"` for the client to resolve. |

---

## Not implemented yet (per original spec's "Not covered" section)

- `GET/PATCH /api/admin/settings` — admin settings/config.
- Extended profile fields on `/api/client/users/me` beyond name/phone/profileImage.
- Razorpay payment integration (service matters are currently auto-marked `PAID` on creation).
- A password/invite flow for professional accounts created via `POST /api/admin/professionals` (they're created without a password).
