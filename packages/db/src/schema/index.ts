import { bigint, index, pgTable, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";

export const chunkAcknowledgements = pgTable(
  "chunk_acknowledgements",
  {
    chunkId: text("chunk_id").primaryKey(),
    sessionId: text("session_id").notNull(),
    checksum: text("checksum").notNull(),
    byteSize: bigint("byte_size", { mode: "number" }).notNull(),
    bucketKey: text("bucket_key").notNull(),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("chunk_ack_session_id_idx").on(table.sessionId),
    uniqueIndex("chunk_ack_bucket_key_uidx").on(table.bucketKey),
  ],
);
