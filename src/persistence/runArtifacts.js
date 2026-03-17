import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { createGzip, gunzip } from "node:zlib";
import { promisify } from "node:util";

const gunzipAsync = promisify(gunzip);

export const RAW_RUN_STORAGE_FORMAT = "jsonl";
export const COMPRESSED_RUN_STORAGE_FORMAT = "jsonl.gz";

export function buildRunArtifactFileName(
  runId,
  storageFormat = RAW_RUN_STORAGE_FORMAT
) {
  return `${runId}.${storageFormat}`;
}

export function getStorageFormatForFileName(fileName) {
  if (fileName.endsWith(`.${COMPRESSED_RUN_STORAGE_FORMAT}`)) {
    return COMPRESSED_RUN_STORAGE_FORMAT;
  }

  if (fileName.endsWith(`.${RAW_RUN_STORAGE_FORMAT}`)) {
    return RAW_RUN_STORAGE_FORMAT;
  }

  return null;
}

export function extractRunIdFromFileName(fileName) {
  const storageFormat = getStorageFormatForFileName(fileName);

  if (!storageFormat) {
    return null;
  }

  return fileName.slice(0, -(storageFormat.length + 1));
}

export function isRunArtifactFileName(fileName) {
  return Boolean(getStorageFormatForFileName(fileName));
}

function pushUnique(values, value) {
  if (value && !values.includes(value)) {
    values.push(value);
  }
}

export function getRunArtifactCandidateNames(runId, summary = null) {
  const candidates = [];
  const preferRawFirst = summary?.status === "live";
  const preferredStorageFormat =
    summary?.storageFormat || (preferRawFirst ? RAW_RUN_STORAGE_FORMAT : null);

  pushUnique(candidates, summary?.fileName);
  pushUnique(
    candidates,
    preferredStorageFormat
      ? buildRunArtifactFileName(runId, preferredStorageFormat)
      : null
  );

  if (preferRawFirst) {
    pushUnique(candidates, buildRunArtifactFileName(runId, RAW_RUN_STORAGE_FORMAT));
    pushUnique(
      candidates,
      buildRunArtifactFileName(runId, COMPRESSED_RUN_STORAGE_FORMAT)
    );
  } else {
    pushUnique(
      candidates,
      buildRunArtifactFileName(runId, COMPRESSED_RUN_STORAGE_FORMAT)
    );
    pushUnique(candidates, buildRunArtifactFileName(runId, RAW_RUN_STORAGE_FORMAT));
  }

  return candidates;
}

export async function resolveRunArtifactPath(directoryPath, runId, summary = null) {
  const candidates = getRunArtifactCandidateNames(runId, summary);

  for (const fileName of candidates) {
    const filePath = path.join(directoryPath, fileName);

    try {
      await fs.access(filePath);
      return filePath;
    } catch (error) {
      if (error.code !== "ENOENT") {
        throw error;
      }
    }
  }

  return path.join(directoryPath, candidates[0]);
}

export async function readRunArtifactText(filePath) {
  if (filePath.endsWith(`.${COMPRESSED_RUN_STORAGE_FORMAT}`)) {
    const compressed = await fs.readFile(filePath);
    const raw = await gunzipAsync(compressed);
    return raw.toString("utf8");
  }

  return fs.readFile(filePath, "utf8");
}

export async function readRunArtifactPoints(filePath) {
  const raw = await readRunArtifactText(filePath);

  return raw
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export async function compressRunArtifact(sourcePath) {
  const outputPath = `${sourcePath}.gz`;
  const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;

  try {
    await pipeline(
      createReadStream(sourcePath),
      createGzip({ level: 9 }),
      createWriteStream(temporaryPath)
    );

    const [sourceStats, outputStats] = await Promise.all([
      fs.stat(sourcePath),
      fs.stat(temporaryPath)
    ]);

    await fs.rename(temporaryPath, outputPath);

    return {
      outputPath,
      inputBytes: sourceStats.size,
      outputBytes: outputStats.size
    };
  } catch (error) {
    await fs.rm(temporaryPath, { force: true });
    throw error;
  }
}
