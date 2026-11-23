# Biometric integration contract — `generic_push_v1`

**No vendor SDK or vendor API is assumed or implemented.** This is the platform's own vendor-neutral contract. A device that can make HTTPS calls, or an on-premise bridge that reads from a vendor device or cloud, translates its data to this contract. Vendor-specific adapters will be built only after the actual hardware model and its documented API are confirmed.

**Privacy:** send attendance events only. Biometric templates, fingerprints or face images must never be sent, and the API has no field for them.

## Registration

1. Tenant needs the `attendance.biometric` entitlement (platform) and the module enabled (tenant).
2. IT admin: Attendance setup → Biometric devices → Register (branch, serial number, name).
3. The API key (`dev_<prefix>.<secret>`) is shown **once**. Store it in the device or bridge configuration. Rotating it invalidates the old key immediately.
4. Map each device enrolment ID ("device user ID") to an employee. Mappings are per tenant, so a replacement device with the same enrolment IDs needs no remapping.

## Push request

```
POST /api/v1/devices/events
X-Device-Key: dev_xxxxxxxx.yyyyyyyy…
Content-Type: application/json

{
  "deviceTime": "2026-11-03T09:35:12+05:30",          // device's current clock, with offset
  "events": [                                          // 1–500 per request
    { "eventId": "000123",                             // unique per device, stable across retries
      "deviceUserId": "1001",                          // enrolment id on the device
      "timestamp": "2026-11-03T09:31:04",              // ISO with offset, or naive local time (branch timezone)
      "direction": "in" }                              // in | out | unknown (default unknown)
  ]
}
```

Response `200`:

```json
{ "accepted": 1, "duplicates": 0, "unmapped": 0, "rejected": 0, "clockDriftSeconds": 8, "warning": null }
```

| Status | Meaning |
|---|---|
| 401 | Missing or invalid key |
| 403 `device_inactive` | Device disabled or replaced |
| 404 | `FEATURE_ATTENDANCE_BIOMETRIC` is off. Retry later; do not drop events |
| 409 `feature_not_configured` | The feature is on but not set up yet. Retry later; do not drop events |
| 400 | Payload invalid (whole batch rejected) |
| 429 | More than 120 requests/minute from this IP |

## Processing

- **Clock drift:** drift = `deviceTime − server time`, rounded to whole seconds. Each event time is corrected by that drift. The original device time is stored in `device_time`. Drift beyond `attendance.max_device_clock_drift_seconds` (default 300) is shown as a device warning.
- **Dedupe:** `(tenant, "<serial>:<eventId>")`. Resending a batch, for example after an offline period, is safe.
- **Rejected:** corrected time more than 5 minutes in the future or older than 90 days.
- **Unmapped:** stored with status `unmapped` and shown in the admin queue. When the enrolment ID is mapped, these events are attached to the employee and the affected days are recalculated.
- **Health:** `last_sync_at`, `last_clock_drift_seconds` and `last_error` per device. The module reports `degraded` if any active device hasn't synced in 24 hours.

## Bridge guidance

Poll the device or vendor cloud, keep a local cursor of the last pushed event ID, push in batches of ≤ 500, and retry with exponential backoff on network errors, 429 and 5xx. Never retry 400 without fixing the payload. Keep events queued while the API returns 403 404 or `feature_not_configured`.
