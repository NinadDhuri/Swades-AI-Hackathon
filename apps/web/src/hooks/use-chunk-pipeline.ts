"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { env } from "@my-better-t-app/env/web";

import type { WavChunk } from "@/hooks/use-recorder";

const RECORDING_DIRECTORY = "recording-chunks";
const MANIFEST_FILE = "manifest.json";
const PROCESS_INTERVAL_MS = 4_000;

interface StoredChunkMeta {
  chunkId: string;
  sessionId: string;
  checksum: string;
  createdAt: number;
  duration: number;
}

interface PipelineState {
  pendingCount: number;
  syncedCount: number;
  lastError: string | null;
}

const toChunkFileName = ({ sessionId, chunkId }: Pick<StoredChunkMeta, "sessionId" | "chunkId">): string =>
  `${sessionId}__${chunkId}.wav`;

const toMetaFileName = ({ sessionId, chunkId }: Pick<StoredChunkMeta, "sessionId" | "chunkId">): string =>
  `${sessionId}__${chunkId}.json`;

const getSessionId = (): string => {
  const existing = localStorage.getItem("recording-session-id");
  if (existing) {
    return existing;
  }

  const newSessionId = crypto.randomUUID();
  localStorage.setItem("recording-session-id", newSessionId);
  return newSessionId;
};

const blobToBase64 = async (blob: Blob): Promise<string> => {
  const bytes = await blob.arrayBuffer();
  const byteView = new Uint8Array(bytes);
  let binary = "";
  for (const byte of byteView) {
    binary += String.fromCodePoint(byte);
  }
  return btoa(binary);
};

const hashBuffer = async (buffer: ArrayBuffer): Promise<string> => {
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

const readJsonFromFile = async <T>(directory: FileSystemDirectoryHandle, fileName: string): Promise<T | null> => {
  try {
    const handle = await directory.getFileHandle(fileName);
    const file = await handle.getFile();
    const raw = await file.text();
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
};

const readBlobFromFile = async (directory: FileSystemDirectoryHandle, fileName: string): Promise<Blob | null> => {
  try {
    const handle = await directory.getFileHandle(fileName);
    return await handle.getFile();
  } catch {
    return null;
  }
};

const readManifest = async (directory: FileSystemDirectoryHandle): Promise<StoredChunkMeta[]> => {
  const manifest = await readJsonFromFile<StoredChunkMeta[]>(directory, MANIFEST_FILE);
  return manifest ?? [];
};

const writeManifest = async (
  directory: FileSystemDirectoryHandle,
  entries: StoredChunkMeta[],
): Promise<void> => {
  const manifestHandle = await directory.getFileHandle(MANIFEST_FILE, { create: true });
  const manifestWriter = await manifestHandle.createWritable();
  await manifestWriter.write(JSON.stringify(entries));
  await manifestWriter.close();
};

export const useChunkPipeline = () => {
  const [pipelineState, setPipelineState] = useState<PipelineState>({
    pendingCount: 0,
    syncedCount: 0,
    lastError: null,
  });

  const sessionIdRef = useRef<string | null>(null);
  const reconcileLockRef = useRef(false);

  const opfsReady = useMemo(
    () => typeof window !== "undefined" && "storage" in navigator && "getDirectory" in navigator.storage,
    [],
  );

  const getDirectory = useCallback(async (): Promise<FileSystemDirectoryHandle | null> => {
    if (!opfsReady) {
      return null;
    }

    const root = await navigator.storage.getDirectory();
    return root.getDirectoryHandle(RECORDING_DIRECTORY, { create: true });
  }, [opfsReady]);

  const deleteStoredChunk = useCallback(
    async (meta: StoredChunkMeta): Promise<void> => {
      const directory = await getDirectory();
      if (!directory) {
        return;
      }

      await directory.removeEntry(toChunkFileName(meta)).catch(() => undefined);
      await directory.removeEntry(toMetaFileName(meta)).catch(() => undefined);
      const currentManifest = await readManifest(directory);
      const nextManifest = currentManifest.filter((entry) => entry.chunkId !== meta.chunkId);
      await writeManifest(directory, nextManifest);
    },
    [getDirectory],
  );

  const uploadChunk = useCallback(async (meta: StoredChunkMeta, blob: Blob): Promise<boolean> => {
    const base64 = await blobToBase64(blob);

    const response = await fetch(`${env.NEXT_PUBLIC_SERVER_URL}/api/chunks/upload`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify({
        sessionId: meta.sessionId,
        chunkId: meta.chunkId,
        checksum: meta.checksum,
        data: base64,
      }),
    });

    return response.ok;
  }, []);

  const listStoredChunks = useCallback(async (): Promise<StoredChunkMeta[]> => {
    const directory = await getDirectory();
    if (!directory) {
      return [];
    }

    const chunks = await readManifest(directory);
    return chunks.sort((a, b) => a.createdAt - b.createdAt);
  }, [getDirectory]);

  const persistChunk = useCallback(
    async (chunk: WavChunk): Promise<StoredChunkMeta | null> => {
      const directory = await getDirectory();
      if (!directory) {
        setPipelineState((current) => ({
          ...current,
          lastError: "OPFS is unavailable in this browser",
        }));
        return null;
      }

      if (!sessionIdRef.current) {
        sessionIdRef.current = getSessionId();
      }

      const chunkBuffer = await chunk.blob.arrayBuffer();
      const meta: StoredChunkMeta = {
        chunkId: chunk.id,
        sessionId: sessionIdRef.current,
        checksum: await hashBuffer(chunkBuffer),
        createdAt: chunk.timestamp,
        duration: chunk.duration,
      };

      const chunkHandle = await directory.getFileHandle(toChunkFileName(meta), { create: true });
      const chunkWriter = await chunkHandle.createWritable();
      await chunkWriter.write(chunkBuffer);
      await chunkWriter.close();

      const metaHandle = await directory.getFileHandle(toMetaFileName(meta), { create: true });
      const metaWriter = await metaHandle.createWritable();
      await metaWriter.write(JSON.stringify(meta));
      await metaWriter.close();

      const currentManifest = await readManifest(directory);
      const nextManifest = [...currentManifest.filter((entry) => entry.chunkId !== meta.chunkId), meta];
      await writeManifest(directory, nextManifest);

      setPipelineState((current) => ({
        ...current,
        pendingCount: current.pendingCount + 1,
        lastError: null,
      }));

      return meta;
    },
    [getDirectory],
  );

  const processQueue = useCallback(async (): Promise<void> => {
    if (reconcileLockRef.current) {
      return;
    }

    reconcileLockRef.current = true;
    try {
      const directory = await getDirectory();
      if (!directory) {
        return;
      }

      const storedChunks = await listStoredChunks();
      let syncedNow = 0;

      for (const meta of storedChunks) {
        const statusResponse = await fetch(
          `${env.NEXT_PUBLIC_SERVER_URL}/api/chunks/status?sessionId=${meta.sessionId}&chunkId=${meta.chunkId}`,
        );
        if (!statusResponse.ok) {
          continue;
        }

        const statusPayload = (await statusResponse.json()) as { acked: boolean; inBucket: boolean };

        const chunkBlob = await readBlobFromFile(directory, toChunkFileName(meta));

        if (statusPayload.acked && statusPayload.inBucket) {
          await deleteStoredChunk(meta);
          syncedNow += 1;
          continue;
        }

        if (!chunkBlob) {
          continue;
        }

        const uploaded = await uploadChunk(meta, chunkBlob);
        if (uploaded) {
          await deleteStoredChunk(meta);
          syncedNow += 1;
        }
      }

      const pendingAfterRun = (await listStoredChunks()).length;

      setPipelineState((current) => ({
        ...current,
        pendingCount: pendingAfterRun,
        syncedCount: current.syncedCount + syncedNow,
        lastError: null,
      }));
    } catch (error) {
      setPipelineState((current) => ({
        ...current,
        lastError: error instanceof Error ? error.message : "Failed to process chunk pipeline",
      }));
    } finally {
      reconcileLockRef.current = false;
    }
  }, [deleteStoredChunk, getDirectory, listStoredChunks, uploadChunk]);

  const addChunkToPipeline = useCallback(
    async (chunk: WavChunk): Promise<void> => {
      const meta = await persistChunk(chunk);
      if (!meta) {
        return;
      }

      await processQueue();
    },
    [persistChunk, processQueue],
  );

  useEffect(() => {
    if (!opfsReady) {
      return;
    }

    if (!sessionIdRef.current) {
      sessionIdRef.current = getSessionId();
    }

    void processQueue();

    const intervalId = window.setInterval(() => {
      void processQueue();
    }, PROCESS_INTERVAL_MS);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [opfsReady, processQueue]);

  return {
    ...pipelineState,
    sessionId: sessionIdRef.current,
    addChunkToPipeline,
    forceReconcile: processQueue,
    isOpfsAvailable: opfsReady,
  };
};
