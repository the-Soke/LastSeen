# LastSeen

LastSeen is a community-powered missing-child response platform with:
- Guided case reporting
- Public discovery feed + map
- Anonymous tip submission
- Assistive AI review tools (facial similarity + memory match)
- Reporter auth (signup/login) and case resolution flow

This repo contains both backend (Node.js/Express + MySQL) and static frontend pages.

## Tech Stack

- Backend: Node.js, Express
- Database: MySQL (`mysql2`), Sequelize (for migration runner)
- AI libs: `@vladmandic/face-api`, `@tensorflow/tfjs` (WASM fallback)
- Notifications: Web Push, SMTP, optional SMS gateway
- Storage:
  - Local disk (`/uploads`) for local dev
  - S3-compatible storage
  - Cloudinary (recommended for simple hosted image persistence)
- Frontend: static HTML/CSS/JS pages served by Express

## Project Structure

```text
client/public/                  # HTML pages (Report, Feed, Tip, Auth, Resolve, AI)
server/src/
  app.js                        # Express app setup, routes, security, static serving
  server.js                     # HTTP startup + background jobs
  api/routes/                   # API routes
  api/middlewares/uploadHandler.js
database/
  migrate.js                    # JS migration runner
  migrations/*.js               # ordered schema migrations
```

## Prerequisites

- Node.js 20+ recommended
- MySQL 8+ recommended

## Installation

```bash
npm install
```

## Environment Configuration

1. Copy `.env.example` to `.env`
2. Fill values for your environment

### Core variables

- `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, `DB_NAME`
- `PORT` (local default: `4000`)
- `ALLOWED_ORIGIN`
- `AUTH_SECRET`
- `DATA_ENCRYPTION_KEY` (required in production)

Generate `DATA_ENCRYPTION_KEY`:

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```

### Storage options

Set one storage mode:

- Local (default if unset):
  - `STORAGE_DRIVER=local`
- S3:
  - `STORAGE_DRIVER=s3`
  - `S3_REGION`, `S3_BUCKET`, `S3_ACCESS_KEY`, `S3_SECRET_KEY`
  - optional: `S3_ENDPOINT`, `S3_PUBLIC_URL`
- Cloudinary:
  - `STORAGE_DRIVER=cloudinary`
  - `CLOUDINARY_CLOUD_NAME`
  - `CLOUDINARY_API_KEY`
  - `CLOUDINARY_API_SECRET`
  - optional: `CLOUDINARY_FOLDER` (default `lastseen/photos`)

Important:
- Do not commit secrets.
- Rotate credentials immediately if exposed.

### Optional integrations

- Web Push:
  - `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_EMAIL`
- SMS:
  - `AT_API_KEY`, `AT_USERNAME`
- SMTP:
  - `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`

## Database Setup

Create DB first (example name: `lastseen`), then run migrations:

```bash
npm run migrate
```

Migration runner:
- Applies files in `database/migrations/*.js` in order
- Tracks applied migrations in `_migrations`
- Safe on rerun (already-applied migrations are skipped)

## Running the App

Production-like run:

```bash
npm start
```

Development with auto-reload:

```bash
npm run dev
```

Default local API URL:
- `http://localhost:4000`

## Main Web Pages

- `/report` -> report wizard
- `/feed` -> public discovery feed + case detail modal
- `/tip` -> anonymous tip form
- `/auth` -> signup/login
- `/resolve` -> reporter case resolution
- `/ai` -> AI review panel

## API Quick Reference

- `POST /api/reports` -> create report
- `GET /api/reports` -> list cases (`status`, `limit`, `offset`)
- `GET /api/reports/:caseId` -> full case detail
- `PATCH /api/reports/:caseId/resolve` -> reporter resolves case
- `PATCH /api/reports/:caseId/status` -> status update
- `POST /api/tips` -> submit anonymous tip
- `POST /api/auth/signup` / `POST /api/auth/login`
- `GET /api/auth/me`

## Notable Behaviors

- Report map uses reverse geocoding (OpenStreetMap/Nominatim) to auto-fill address from selected coordinates.
- Feed cards are clickable and open detailed case modal.
- AI outputs are assistive and designed for human review workflows.

## Deployment Notes (Render/Clever/etc.)

1. Set environment variables on the hosting platform (not in repo).
2. Ensure `PORT` is platform-compatible.
3. Use persistent media storage in production:
   - Prefer Cloudinary or S3
   - Avoid local storage for hosted environments
4. Run migrations after deploy:
   - `npm run migrate`

## Troubleshooting

### `Auth schema not ready. Run: npm run migrate`
- Run migrations on the target DB:
  - `npm run migrate`

### Photos not showing on hosted feed
- Confirm `STORAGE_DRIVER` is set correctly.
- For Cloudinary, verify:
  - `CLOUDINARY_CLOUD_NAME`, `CLOUDINARY_API_KEY`, `CLOUDINARY_API_SECRET`
- Check `/api/reports` and verify `photo_url` values are valid URLs.
- Local storage on hosted servers can be ephemeral.

### `Photo upload failed: Invalid cloud_name ...`
- `CLOUDINARY_CLOUD_NAME` is wrong (must be actual Cloudinary cloud name from dashboard).

### AI optional dependency warnings
- If `@tensorflow/tfjs-node` isn’t installed/supported, app falls back to slower backend.
- This is expected unless native TF binding is available in your runtime.

## Security Checklist

- Set strong `AUTH_SECRET` and `DATA_ENCRYPTION_KEY`
- Never commit `.env`
- Rotate leaked API keys/secrets immediately
- Use HTTPS in production

## License

No license file is currently defined in this repository.
