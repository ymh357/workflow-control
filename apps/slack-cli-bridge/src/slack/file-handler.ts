import { mkdirSync, writeFileSync, rmSync, existsSync } from 'fs';
import { join, basename } from 'path';
import { logger } from '../logger.js';
import type { Config } from '../types.js';

const TMP_BASE = join('/tmp', 'slack-cli-bridge');

interface SlackFile {
  id: string;
  name: string;
  url_private_download?: string;
  size: number;
  mimetype?: string;
}

export const downloadFiles = async (
  files: SlackFile[],
  threadTs: string,
  botToken: string,
  config: Config
): Promise<string[]> => {
  const dir = join(TMP_BASE, threadTs.replaceAll('.', '_'));
  mkdirSync(dir, { recursive: true });

  const paths: string[] = [];

  for (const file of files) {
    if (file.size > config.maxFileSize) {
      logger.warn({ name: file.name, size: file.size }, 'File too large, skipping');
      continue;
    }

    const url = file.url_private_download;
    if (!url) {
      logger.warn({ name: file.name }, 'No download URL');
      continue;
    }

    try {
      const response = await fetch(url, {
        headers: { Authorization: `Bearer ${botToken}` },
      });

      if (!response.ok) {
        logger.error({ status: response.status, name: file.name }, 'File download failed');
        continue;
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      // Sanitize filename to prevent path traversal
      const safeName = basename(file.name);
      const filePath = join(dir, safeName);
      writeFileSync(filePath, buffer);
      paths.push(filePath);
      logger.info({ name: safeName, path: filePath }, 'File downloaded');
    } catch (err) {
      logger.error({ err, name: file.name }, 'File download error');
    }
  }

  return paths;
};

export const cleanupFiles = (threadTs: string): void => {
  const dir = join(TMP_BASE, threadTs.replaceAll('.', '_'));
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    logger.debug({ dir }, 'Cleaned up temp files');
  }
};
