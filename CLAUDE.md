# CLAUDE.md — MeTransfer

This file describes the architecture, conventions, and key decisions in MeTransfer so that AI assistants and contributors can work on the codebase effectively.

---

## What is MeTransfer?

MeTransfer is a **self-hosted photo delivery platform** for photographers. A photographer logs into a private dashboard, creates a named gallery by uploading photos (and optionally a hero background image), then shares the generated link with their client. The client visits a minimal, elegant page and downloads all photos as a single ZIP file.

There is no public registration. The entire admin side is protected by a single shared password.

---

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Runtime | Node.js 18+ |
| Server framework | Express 4 |
| File uploads | multer (disk storage) |
| ZIP creation | archiver |
| Unique IDs | uuid v4 |
| Environment config | dotenv |
| Rate limiting | express-rate-limit |
| Frontend | Vanilla HTML/CSS/JS — no framework, no build step |
| Fonts | Google Fonts (Cormorant Garamond, Montserrat) |

---

## File Structure

```
MeTransfer/
├── server.js           # All server logic — Express app, routes, middleware
├── package.json        # Dependencies and npm scripts
├── Dockerfile          # Docker image definition
├── docker-compose.yml  # Docker Compose service definition (recommended deployment)
├── .env                # Secret config (gitignored) — copy from .env.example
├── .env.example        # Template showing required env vars
├── .dockerignore       # Excludes node_modules, .env, data/ from Docker build context
├── .gitignore          # Excludes .env, node_modules, data/, galleries.json
├── public/
│   ├── admin.html      # Photographer dashboard (login, upload, gallery management)
│   └── customer.html   # Client download page (background image + single download button)
└── data/               # Runtime data root (Docker volume mount at /data)
    ├── uploads/        # Gallery photos, organised as uploads/{galleryId}/
    ├── backgrounds/    # Background images, named {galleryId}.{ext}
    └── galleries.json  # Gallery metadata persisted to disk
```

`data/`, `uploads/`, `backgrounds/`, and `galleries.json` are all generated at runtime and gitignored. `server.js` creates the directories automatically on startup if they do not exist.

---

## Configuration

All secrets and tuneable values live in `.env`. Copy `.env.example` to `.env` and set your values before starting the server.

| Variable | Default | Notes |
|----------|---------|-------|
| `ADMIN_PASSWORD` | *(none — must be set)* | Password to access the admin dashboard |
| `PORT` | `3000` | TCP port the server listens on |
| `HOST` | `localhost` | Hostname used only in startup log output |
| `MAX_UPLOAD_MB` | `200` | Per-file size limit for photo uploads, in MB |
| `MAX_BACKGROUND_MB` | `20` | Size limit for background image uploads, in MB |
| `DATA_DIR` | `__dirname` (project root) | Root directory for uploads, backgrounds, and galleries.json. Set to `/data` in Docker; omit for bare-metal installs. |

`dotenv` is loaded as the very first line of `server.js` so env vars are available everywhere.

In Docker Compose, `DATA_DIR=/data` is set via the `environment` key and the `./data` host directory is mounted at `/data`. `ADMIN_PASSWORD` and other vars come from the `.env` file via `env_file`. This keeps all runtime data in one bind-mount volume that survives container upgrades.

---

## Server Architecture (`server.js`)

### Data model

Galleries are stored in an in-memory `Map<galleryId, GalleryObject>` and flushed to `galleries.json` on every write. On startup the file is read back into memory. All gallery IDs are UUID v4 strings.

```js
{
  id: string,          // UUID v4
  eventName: string,   // Display name set by the photographer
  created: string,     // ISO 8601 timestamp
  files: string[],     // Array of filenames inside uploads/{id}/
  background: string   // Filename inside backgrounds/ (or null)
}
```

### Authentication and security

A single `requireAuth` middleware checks the `X-Admin-Password` request header (or `?password` query param) against `process.env.ADMIN_PASSWORD`. Unauthenticated requests receive HTTP 401.

The `/api/auth/verify` endpoint is the only auth-related route that is itself unprotected — the browser uses it to validate the password on login. It is protected by `authLimiter` (10 attempts per IP per 15 minutes via `express-rate-limit`) to prevent brute-force attacks.

All routes that accept a `:galleryId` URL parameter pass through the `validateGalleryId` middleware before any filesystem operation. This middleware rejects any value that does not match the UUID v4 format (`/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i`), closing the path traversal attack vector.

**Important:** The password travels in a plain HTTP header. In production, always serve behind HTTPS (see README for Nginx + Certbot setup).

### File upload pipeline

Two separate `multer` instances handle different upload types:

- **`upload`** — handles photo uploads into `uploads/{galleryId}/`. File type filter accepts JPEG, PNG, GIF, WebP, TIFF, BMP, and raw formats (CR2, NEF, ARW), plus any MIME type starting with `image/`. Filenames are sanitised by replacing non-alphanumeric characters (except `.`, `-`, `_`) with underscores. Per-file size limit is `MAX_UPLOAD_MB` (default 200 MB).
- **`uploadBackground`** — handles background images into `backgrounds/`. Only JPEG, PNG, GIF, WebP. Named `{galleryId}.{ext}`, replacing any previous background for the same gallery. Size limit is `MAX_BACKGROUND_MB` (default 20 MB).

For new gallery creation the gallery ID must be assigned **before** multer runs (multer determines the destination path immediately). A `generateGalleryId` middleware creates the UUID and inserts a skeleton gallery record into the Map before the upload middleware executes.

### ZIP streaming

`GET /api/gallery/:id/download` creates an `archiver` zip stream and pipes it directly to the response. Compression level is 5. The ZIP filename is derived from the event name (sanitised, max 50 chars).

### Filesystem-first gallery listing

`GET /api/galleries` scans the `uploads/` directory rather than trusting only the in-memory Map. Any directory found on disk that has no corresponding metadata entry gets a synthetic record created automatically. This makes the system resilient to restarts or manual file operations.

---

## API Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `GET` | `/` | — | Serve admin dashboard |
| `POST` | `/api/auth/verify` | — | Verify admin password |
| `POST` | `/api/gallery/create` | ✓ | Create gallery + upload photos |
| `POST` | `/api/gallery/:id/upload` | ✓ | Add more photos to existing gallery |
| `POST` | `/api/gallery/:id/background` | ✓ | Upload/replace background image |
| `GET` | `/api/gallery/:id/info` | — | Gallery metadata (for customer page) |
| `GET` | `/api/gallery/:id/download` | — | Stream photos as ZIP |
| `GET` | `/api/galleries` | ✓ | List all galleries |
| `DELETE` | `/api/gallery/:id` | ✓ | Delete gallery + background |
| `GET` | `/api/background/:id` | — | Serve background image |
| `GET` | `/download/:id` | — | Serve customer download page |

Endpoints marked `—` under Auth are intentionally public so clients can access their gallery without a password.

---

## Frontend Architecture

Both HTML files are standalone — no bundler, no imports, all JavaScript is inline in a `<script>` tag at the bottom of the file.

### `public/admin.html`

A single-page application with two states: **login screen** and **main dashboard**.

- On load, checks `sessionStorage` for a saved password and skips the login screen if found.
- Login calls `POST /api/auth/verify`; on success stores the password in `sessionStorage` and shows the dashboard.
- All subsequent API calls attach the password via an `X-Admin-Password` header using the `authHeaders()` helper.
- Drag-and-drop zone supports individual files **and** recursive folder traversal via the `webkitGetAsEntry` / `FileSystemDirectoryReader` API.
- Gallery creation is a two-step fetch: first `POST /api/gallery/create` (photos), then `POST /api/gallery/:id/background` (background, if any).
- Event names are always HTML-escaped before being inserted into the DOM via the `escapeHtml()` helper (creates a temporary `div`, sets `textContent`, reads `innerHTML`).
- The gallery list is re-fetched after every create or delete operation.

### `public/customer.html`

Minimal, design-forward page. No authentication required.

- Extracts the gallery ID from the URL path on load.
- Calls `GET /api/gallery/:id/info` to get the event name, photo count, and background URL.
- Background image fades in with a CSS transition once loaded.
- Download button links directly to `GET /api/gallery/:id/download` — the browser handles the ZIP download natively.
- Shows a "Gallery Not Found" state if the API returns an error.

---

## Conventions and Gotchas

- **No build step.** Do not introduce a bundler, TypeScript, or a frontend framework without discussing it first. The simplicity is intentional.
- **No external database.** Gallery metadata lives in `galleries.json`. If you need a database, that is a significant architectural change.
- **multer file size limits are configurable via `.env`.** `MAX_UPLOAD_MB` (default 200) applies to photos; `MAX_BACKGROUND_MB` (default 20) applies to background images. Nginx `client_max_body_size` must still be set high enough to match (see README).
- **DATA_DIR decouples code from data.** All filesystem paths for uploads, backgrounds, and galleries.json use `DATA_DIR` (defaulting to `__dirname`). In Docker this is set to `/data` via the `environment` key in docker-compose.yml; bare-metal installs work unchanged with no value set.
- **Backgrounds replace on upload.** Uploading a new background for a gallery deletes the old file from disk.
- **Galleries can be re-discovered from disk.** Do not assume the in-memory Map is the source of truth for what galleries exist; the filesystem is authoritative.
- **Password in sessionStorage.** The admin password is stored in `sessionStorage` (cleared when the tab closes), not `localStorage`. This is intentional — it limits exposure on shared computers.
- **The project was originally named "Photo Portal".** The `package.json` `name` field still says `photo-portal`. The public-facing name is MeTransfer.
