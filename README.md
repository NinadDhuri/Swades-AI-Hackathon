1. **Client-side chunking** — Recording data is split into chunks in the browser
2. **OPFS storage** — Each chunk is persisted to the Origin Private File System before any network call, so nothing is lost if the tab closes or the network drops
3. **Bucket upload** — Chunks are uploaded to a storage bucket (can be a local bucket for testing, e.g. MinIO or a local S3-compatible store)
4. **DB acknowledgment** — Once the bucket confirms receipt, an ack record is written to the database
5. **Reconciliation** — If the DB shows an ack but the chunk is missing from the bucket (e.g. bucket purge, replication lag), the client re-uploads from OPFS to restore consistency

## Tech Stack

- **Next.js** — Frontend (App Router)
- **Hono** — Backend API server
- **Bun** — Runtime
- **Drizzle ORM + PostgreSQL** — Database
- **TailwindCSS + shadcn/ui** — UI
- **Turborepo** — Monorepo build system

## Getting Started

```bash
npm install
```

### Database Setup

1. Make sure you have a PostgreSQL database set up.
2. Update your `apps/server/.env` with your PostgreSQL connection details.
3. Apply the schema:
2. Update your `apps/server/.env` with:
   - `DATABASE_URL`
   - `CORS_ORIGIN` (for local dev, `http://localhost:3001`)
3. Update your `apps/web/.env.local` with:
   - `NEXT_PUBLIC_SERVER_URL` (for local dev, `http://localhost:3000`)
4. Apply the schema:

```bash
npm run db:push
```

### Run Development

```bash
npm run dev
```

- Web app: [http://localhost:3001](http://localhost:3001)
- API server: [http://localhost:3000](http://localhost:3000)

## Implemented API Contract

### `POST /api/chunks/upload`

Uploads a chunk to the local bucket (`apps/server/.bucket`) and writes/updates a DB ack in `chunk_acknowledgements`.

Request body:

```json
{
  "sessionId": "session-uuid",
  "chunkId": "chunk-uuid",
  "checksum": "sha256-hex",
  "data": "base64-wav-payload"
}
```

Response:

```json
{
  "ok": true,
  "chunkId": "chunk-uuid",
  "bucketKey": "session-uuid/chunk-uuid.wav",
  "byteSize": 12345
}
```

### `GET /api/chunks/status?sessionId=<id>&chunkId=<id>`

Returns whether the chunk is acknowledged in DB and physically present in the bucket.

Response:

```json
{
  "ok": true,
  "chunkId": "chunk-uuid",
  "sessionId": "session-uuid",
  "acked": true,
  "inBucket": true
}
```

## OPFS Pipeline Notes

- Chunks are first persisted in OPFS under `recording-chunks/` before any upload attempt.
- The client stores a `manifest.json` to keep a durable queue of pending chunks.
- A reconciliation loop runs periodically and can also be triggered manually from the UI:
  - if `acked=true` and `inBucket=true`, OPFS files are removed;
  - otherwise the client re-uploads from OPFS until both DB and bucket are in sync.

## Load Testing

Target: **300,000 requests** to validate the chunking pipeline under heavy load.

### Setup

Use a load testing tool like [k6](https://k6.io), [autocannon](https://github.com/mcollina/autocannon), or [artillery](https://artillery.io) to simulate concurrent chunk uploads.

Example with **k6**:

```js
import http from "k6/http";
import { check } from "k6";

export const options = {
  scenarios: {
    chunk_uploads: {
      executor: "constant-arrival-rate",
      rate: 5000,           // 5,000 req/s
      timeUnit: "1s",
      duration: "1m",       // → 300K requests in 60s
      preAllocatedVUs: 500,
      maxVUs: 1000,
    },
  },
};

export default function () {
  const data = "x".repeat(1024); // 1KB dummy payload
  const payload = JSON.stringify({
    sessionId: "load-test-session",
    chunkId: `chunk-${__VU}-${__ITER}`,
    data: "x".repeat(1024), // 1KB dummy chunk
    checksum: "test-checksum",
    data: btoa(data),
  });

  const res = http.post("http://localhost:3000/api/chunks/upload", payload, {
    headers: { "Content-Type": "application/json" },
  });

  check(res, {
    "status 200": (r) => r.status === 200,
  });
}
```

Run:

```bash
k6 run load-test.js
```
> Note: k6 does not include `btoa` in all runtimes. If needed, replace with a static base64 test value or use a helper implementation.

### What to Validate

- **No data loss** — every ack in the DB has a matching chunk in the bucket
- **OPFS recovery** — chunks survive client disconnects and can be re-uploaded
- **Throughput** — server handles sustained 5K req/s without dropping chunks
- **Consistency** — reconciliation catches and repairs any bucket/DB mismatches after the run

## Project Structure

```
recoding-assignment/
recording-assignment/
├── apps/
│   ├── web/         # Frontend (Next.js) — chunking, OPFS, upload logic
│   └── server/      # Backend API (Hono) — bucket upload, DB ack
├── packages/
│   ├── ui/          # Shared shadcn/ui components and styles
│   ├── db/          # Drizzle ORM schema & queries
│   ├── env/         # Type-safe environment config
│   └── config/      # Shared TypeScript config
```

## Available Scripts

- `npm run dev` — Start all apps in development mode
- `npm run build` — Build all apps
- `npm run dev:web` — Start only the web app
- `npm run dev:server` — Start only the server
- `npm run check-types` — TypeScript type checking
- `npm run db:push` — Push schema changes to database
- `npm run db:generate` — Generate database client/types
- `npm run db:migrate` — Run database migrations
- `npm run db:studio` — Open database studio UI
