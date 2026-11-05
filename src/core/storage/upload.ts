import { createHash } from 'node:crypto';
import type { FastifyRequest } from 'fastify';
import { audit } from '../audit/audit.js';
import { AppError } from '../http/errors.js';
import type { TenantActor } from '../http/context.js';
import { getScanner, scanRequired } from './clamav.js';
import { detectFile, type Detected } from './sniff.js';
import { ImageStructureError, stripMetadata } from './strip.js';

export interface PreparedUpload extends Detected { bytes: Buffer }

const NOT_SCANNED = () => new AppError(503, 'scanner_unavailable', 'Files cannot be scanned for malware right now, so this upload was refused. Try again later, or tell your administrator.');

/**
 * Every upload path goes through here, before any transaction: the content decides the type (magic bytes), clamd sees the bytes as they arrived,
 * and images lose their metadata. In production a file that could not be scanned is not stored. Elsewhere, with no scanner configured, scanning is skipped.
 */
export async function prepareUpload(req: Pick<FastifyRequest, 'log'>, a: Pick<TenantActor, 'tx' | 'auditBase'>, buf: Buffer, fileName: string): Promise<PreparedUpload> {
  const detected = detectFile(buf, fileName);
  if ('error' in detected) throw new AppError(415, 'unsupported_file', detected.error);
  const scanner = getScanner();
  if (!scanner && scanRequired()) throw NOT_SCANNED();
  if (scanner) {
    const result = await scanner.scan(buf).catch((e: Error) => { req.log.error({ err: e.message }, 'malware scan failed'); throw NOT_SCANNED(); });
    if (!result.clean) {
      await a.tx((db) => audit(db, { ...a.auditBase, action: 'upload.malware_blocked', category: 'security', metadata: { signature: result.signature, contentType: detected.contentType, sha256: createHash('sha256').update(buf).digest('hex') } }));
      throw new AppError(422, 'malware_detected', 'This file was flagged by the malware scanner and was not stored.');
    }
  }
  try {
    return { ...detected, bytes: stripMetadata(buf, detected.contentType) };
  } catch (e) {
    if (e instanceof ImageStructureError) throw new AppError(415, 'unsupported_file', 'This image could not be read. It may be damaged.');
    throw e;
  }
}
