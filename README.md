# Lawxygen Backend

This project contains the backend folder structure for the Lawxygen application.

## Structure

- src/
  - config/
  - controllers/
    - client/
    - admin/
    - professional/
  - middleware/
  - models/
  - routes/
    - client/ — mounted at `/api/client`
    - admin/ — mounted at `/api/admin`
    - professional/ — mounted at `/api/professional`
  - utils/
  - app.js
  - server.js

Controllers and routes are split by audience (`client`, `admin`, `professional`), each with its own `index.js` router mounted under the matching `/api/<audience>` prefix in `app.js`. Models are shared across audiences.

## Environment

Copy `.env.example` to `.env` and update values as needed.

## Admin account

There is no admin signup endpoint. Create the first admin with:

```
npm run seed:admin
```

This reads `SEED_ADMIN_NAME` / `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` from `.env` and creates a `super_admin` user if one doesn't already exist for that email.
