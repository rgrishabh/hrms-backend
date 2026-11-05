import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withPlatformBypass, withTenant } from '../../db/tx.js';
import { sha256, safeEqualHex } from '../../core/crypto/index.js';
import { AppError, unauthorized } from '../../core/http/errors.js';
import { assertFeatureUsable } from '../../core/features/state.js';
import { getSettingValue } from '../../core/settings/service.js';
import { audit } from '../../core/audit/audit.js';
import { recordEvent, recalculateRange } from './service.js';
import { localDate, zonedToInstant, addDays } from './time.js';

/**
 * Vendor-neutral biometric ingestion — adapter `generic_push_v1`.
 *
 * Contract (docs/BIOMETRIC_INTEGRATION.md): a device or an on-premise bridge
 * POSTs batches of attendance events (never biometric templates) with
 *   X-Device-Key: <prefix>.<secret>
 * The device reports its own current clock (`deviceTime`); the server computes
 * drift = deviceTime − serverNow and corrects each event by it. Events are
 * deduplicated by (device serial, eventId), so retries and offline re-syncs are safe.
 *
 * No vendor SDK is assumed. Vendor-specific adapters (e.g. pulling from a
 * vendor's cloud API) must translate to this contract after the actual
 * hardware/API is confirmed.
 */
const LocalTs = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?$/);
const Batch = z.object({
  deviceTime: z.iso.datetime({ offset: true }),
  events: z
    .array(
      z.object({
        eventId: z.string().min(1).max(64),
        deviceUserId: z.string().min(1).max(64),
        // Either an ISO instant with offset, or a naive local timestamp in the branch timezone.
        timestamp: z.union([z.iso.datetime({ offset: true }), LocalTs]),
        direction: z.enum(['in', 'out', 'unknown']).default('unknown'),
      }),
    )
    .min(1)
    .max(500),
});

export async function deviceIngestRoutes(app: FastifyInstance) {
  const { pool } = app.deps;

  app.post('/events', { schema: { body: Batch }, config: { rateLimit: { max: 120, timeWindow: '1 minute' } } }, async (req) => {
    const key = req.headers['x-device-key'];
    if (typeof key !== 'string' || !key.includes('.')) throw unauthorized('Device key required');
    const [prefix, secret] = key.split('.', 2) as [string, string];
    // Key lookup crosses tenants by design (the key identifies the tenant); nothing else runs under bypass.
    const dev = await withPlatformBypass(
      pool,
      async (db) =>
        (
          await db.query<{ id: string; tenant_id: string; branch_id: string; serial_number: string; status: string; api_key_hash: string }>(
            `SELECT d.id, d.tenant_id, d.branch_id, d.serial_number, d.status, d.api_key_hash FROM attendance_devices d JOIN tenants t ON t.id=d.tenant_id
        WHERE d.api_key_prefix=$1 AND t.status='active'`,
            [prefix],
          )
        ).rows[0],
    );
    if (!dev || !safeEqualHex(sha256(secret), dev.api_key_hash)) throw unauthorized('Invalid device key');
    if (dev.status !== 'active') throw new AppError(403, 'device_inactive', 'This device is not active');
    const body = Batch.parse(req.body);

    return withTenant(pool, dev.tenant_id, async (db) => {
      await assertFeatureUsable(db, dev.tenant_id, 'attendance.biometric');
      const tz = await getSettingValue<string>(db, dev.tenant_id, 'general.timezone', dev.branch_id);
      const maxDrift = await getSettingValue<number>(db, dev.tenant_id, 'attendance.max_device_clock_drift_seconds');
      const serverNow = Date.now();
      // Device clocks have 1-second resolution; correct by whole seconds so stored times carry no network-jitter milliseconds.
      const driftSec = Math.round((Date.parse(body.deviceTime) - serverNow) / 1000);
      const driftMs = driftSec * 1000;
      const mappings = new Map(
        (
          await db.query<{ device_user_id: string; employee_id: string }>(
            `SELECT device_user_id, employee_id FROM device_user_mappings WHERE tenant_id=$1 AND device_user_id = ANY($2)`,
            [dev.tenant_id, [...new Set(body.events.map((e) => e.deviceUserId))]],
          )
        ).rows.map((r) => [r.device_user_id, r.employee_id]),
      );

      let accepted = 0,
        duplicates = 0,
        unmapped = 0,
        rejected = 0;
      const touched = new Map<string, string[]>();
      for (const e of body.events) {
        const reported = LocalTs.safeParse(e.timestamp).success ? zonedToInstant(e.timestamp.slice(0, 10), e.timestamp.slice(11), tz) : new Date(e.timestamp);
        const corrected = new Date(reported.getTime() - driftMs);
        // Reject events claiming to be in the future (beyond small tolerance) or absurdly old.
        if (corrected.getTime() > serverNow + 5 * 60e3 || corrected.getTime() < serverNow - 90 * 86400e3) {
          rejected++;
          continue;
        }
        const employeeId = mappings.get(e.deviceUserId) ?? null;
        const ev = await recordEvent(db, dev.tenant_id, {
          employeeId,
          source: 'biometric',
          sourceRef: `${dev.serial_number}:${e.eventId}`,
          eventTime: corrected,
          deviceTime: reported,
          direction: e.direction,
          deviceId: dev.id,
          deviceUserId: e.deviceUserId,
          status: employeeId ? 'accepted' : 'unmapped',
        });
        if (!ev) {
          duplicates++;
          continue;
        }
        if (!employeeId) {
          unmapped++;
          continue;
        }
        accepted++;
        const list = touched.get(employeeId) ?? [];
        list.push(localDate(corrected, tz));
        touched.set(employeeId, list);
      }
      for (const [empId, dates] of touched) {
        dates.sort();
        await recalculateRange(db, dev.tenant_id, empId, addDays(dates[0]!, -1), dates[dates.length - 1]!);
      }
      const driftError = Math.abs(driftSec) > maxDrift ? `Clock drift ${driftSec}s exceeds tolerance ${maxDrift}s` : null;
      await db.query(`UPDATE attendance_devices SET last_sync_at=now(), last_clock_drift_seconds=$3, last_error=$4 WHERE tenant_id=$1 AND id=$2`, [
        dev.tenant_id,
        dev.id,
        driftSec,
        driftError,
      ]);
      await audit(db, {
        tenantId: dev.tenant_id,
        actorId: null,
        actorType: 'device',
        action: 'attendance.device_sync',
        targetType: 'device',
        targetId: dev.id,
        metadata: { received: body.events.length, accepted, duplicates, unmapped, rejected, driftSec },
        requestId: req.id,
        ip: req.ip,
      });
      return { accepted, duplicates, unmapped, rejected, clockDriftSeconds: driftSec, warning: driftError };
    });
  });
}
