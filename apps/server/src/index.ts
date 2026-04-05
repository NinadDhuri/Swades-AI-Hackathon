import { mkdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { db } from "@my-better-t-app/db";
import { chunkAcknowledgements } from "@my-better-t-app/db";
import { env } from "@my-better-t-app/env/server";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { logger } from "hono/logger";
import { z } from "zod";

const app = new Hono();

const bucketRootPath = path.resolve(process.cwd(), ".bucket");

const uploadChunkSchema = z.object({
  sessionId: z.string().min(1),
  chunkId: z.string().min(1),
  data: z.string().min(1),
  checksum: z.string().min(1),
});

const chunkStatusSchema = z.object({
  sessionId: z.string().min(1),
  chunkId: z.string().min(1),
});

const toBucketKey = (sessionId: string, chunkId: string): string => `${sessionId}/${chunkId}.wav`;

const toBucketPath = (bucketKey: string): string => path.join(bucketRootPath, bucketKey);

const bucketFileExists = async (bucketPath: string): Promise<boolean> => {
  try {
    const details = await stat(bucketPath);
    return details.isFile();
  } catch {
    return false;
  }
};

app.use(logger());
app.use(
  "/*",
  cors({
    origin: env.CORS_ORIGIN,
    allowMethods: ["GET", "POST", "OPTIONS"],
  }),
);

app.get("/", (c) => {
  return c.text("OK");
});

app.post("/api/chunks/upload", async (c) => {
  const parsed = uploadChunkSchema.safeParse(await c.req.json());
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.flatten() }, 400);
  }

  const { sessionId, chunkId, data, checksum } = parsed.data;
  const bucketKey = toBucketKey(sessionId, chunkId);
  const bucketPath = toBucketPath(bucketKey);

  const chunkBuffer = Buffer.from(data, "base64");

  await mkdir(path.dirname(bucketPath), { recursive: true });
  await writeFile(bucketPath, chunkBuffer);

  await db
    .insert(chunkAcknowledgements)
    .values({
      chunkId,
      sessionId,
      checksum,
      byteSize: chunkBuffer.byteLength,
      bucketKey,
      updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: chunkAcknowledgements.chunkId,
      set: {
        sessionId,
        checksum,
        byteSize: chunkBuffer.byteLength,
        bucketKey,
        updatedAt: new Date(),
      },
    });

  return c.json({ ok: true, chunkId, bucketKey, byteSize: chunkBuffer.byteLength });
});

app.get("/api/chunks/status", async (c) => {
  const parsed = chunkStatusSchema.safeParse(c.req.query());
  if (!parsed.success) {
    return c.json({ ok: false, error: parsed.error.flatten() }, 400);
  }

  const { sessionId, chunkId } = parsed.data;
  const bucketKey = toBucketKey(sessionId, chunkId);
  const bucketPath = toBucketPath(bucketKey);

  const ackRecord = await db.query.chunkAcknowledgements.findFirst({
    where: and(
      eq(chunkAcknowledgements.chunkId, chunkId),
      eq(chunkAcknowledgements.sessionId, sessionId),
    ),
  });

  const inBucket = await bucketFileExists(bucketPath);

  return c.json({
    ok: true,
    chunkId,
    sessionId,
    acked: Boolean(ackRecord),
    inBucket,
  });
});

export default app;
