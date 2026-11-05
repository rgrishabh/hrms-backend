import { z } from 'zod';

/**
 * Response shapes for the OpenAPI document, every JSON route.
 * Generated once from what the whole test suite answered and which database column each value came from, then kept honest by `registerResponseCheck`: every test app refuses an answer its route's
 * schema does not describe. See D67.
 *  - Strict objects, so a new field fails the suite until it is declared. A value from a JSON column has what was seen, and may have more: a loose object.
 *  - Nullable where null was seen, or where the column can be null. A field seen only as null takes its column's type, or is `z.unknown()` when it has no column.
 *  - Optional where some answer left it out: `masked`, and what masking removes.
 * Documentation only: the serializer is plain JSON.stringify, so these can never remove a field from an answer.
 */

/** A route that answers a file: which types it can be. It has no JSON shape to declare. */
export const file = (...types: string[]) => ({ description: 'A file', content: Object.fromEntries(types.map((t) => [t, { schema: { type: 'string', format: 'binary' } }])) });

export const GetHealth200 = z.strictObject({ status: z.literal('ok'), version: z.string() });
export const GetReady200 = z.strictObject({ status: z.literal('ready') });
export const GetReady503 = z.strictObject({ status: z.literal('unavailable') });

const AttendanceMeTodayLinked = z.strictObject({
  channels: z.strictObject({
    mobile: z.boolean(),
    web: z.boolean(),
  }),
  daily: z
    .strictObject({
      calc_version: z.number(),
      calculated_at: z.string(),
      day_type: z.string(),
      duty_fraction: z.string(),
      early_exit_minutes: z.number(),
      employee_id: z.string(),
      exceptions: z.array(z.string()),
      first_in: z.string(),
      last_out: z.unknown().optional(),
      late_minutes: z.number(),
      leave_fraction: z.string(),
      leave_type_code: z.unknown().optional(),
      locked: z.boolean(),
      overtime_minutes: z.number(),
      policy_snapshot: z.strictObject({
        minGapSeconds: z.number(),
        overtimeEnabled: z.boolean(),
        schedule: z.string(),
        shift: z.string(),
        timezone: z.string(),
        weeklyOffs: z.array(z.number()),
      }),
      punch_count: z.number(),
      shift_id: z.string(),
      status: z.string(),
      tenant_id: z.string(),
      work_date: z.string(),
      worked_minutes: z.number(),
    })
    .nullable(),
  events: z.array(
    z.strictObject({
      direction: z.string(),
      event_time: z.string(),
      id: z.string(),
      source: z.string(),
    }),
  ),
  linked: z.boolean(),
  locationMode: z.string(),
  nextDirection: z.string(),
  timezone: z.string(),
  today: z.string(),
});

export const DeleteAttendanceGeofencesByBranchId200 = z.strictObject({ ok: z.boolean() });

export const DeleteAttendanceHolidaysById200 = z.strictObject({ ok: z.boolean() });

export const DeleteAttendanceRosterOverridesByEmployeeIdByDate200 = z.strictObject({ ok: z.boolean() });

export const DeleteAuthSessionsById200 = z.strictObject({ ok: z.boolean() });

export const DeleteExpensesAllowanceRatesById200 = z.strictObject({ ok: z.boolean() });

export const DeleteExpensesClaimsByIdItemsByItemId200 = z.strictObject({ ok: z.boolean() });

export const DeletePayrollRunsByIdAdjustmentsByAdjId200 = z.strictObject({ ok: z.boolean() });

export const DeleteReportsSavedById200 = z.strictObject({ ok: z.boolean() });

export const DeleteReportsSavedByIdSchedule200 = z.strictObject({ ok: z.boolean() });

export const DeleteTenantCompanyImagesByKind200 = z.strictObject({ ok: z.boolean() });

export const DeleteTenantRolesByKey200 = z.strictObject({ ok: z.boolean() });

export const DeleteTenantSettingsByKey200 = z.strictObject({ ok: z.boolean() });

export const GetAccountingLedgerMap200 = z.strictObject({
  heads: z.array(z.strictObject({ key: z.string(), label: z.string() })),
  items: z.array(z.strictObject({ ledger_name: z.string(), map_key: z.string(), updated_at: z.string() })),
});

export const GetAccountingPayrollRunsByIdJournal200 = z.strictObject({
  balanced: z.boolean(),
  date: z.string(),
  entries: z.array(z.strictObject({ credit: z.string(), debit: z.string(), key: z.string(), label: z.string(), ledger: z.string().nullable() })),
  missing: z.array(z.string()),
  narration: z.string(),
  number: z.string(),
  total: z.string(),
});

export const GetAccountingSources200 = z.strictObject({
  batches: z.array(
    z.strictObject({
      claim_count: z.number(),
      created_at: z.string(),
      id: z.string(),
      last_export: z.strictObject({ at: z.string(), by: z.string(), format: z.string() }).nullable().optional(),
      paid_at: z.string().nullable().optional(),
      payment_reference: z.string().nullable().optional(),
      status: z.string(),
      total: z.string(),
    }),
  ),
  runs: z.array(
    z.strictObject({
      excluded: z.number().optional(),
      id: z.string(),
      kind: z.string(),
      last_export: z.looseObject({ at: z.string(), by: z.string(), format: z.string() }).nullable(),
      legal_entity: z.string(),
      masked: z.boolean().optional(),
      maskedFields: z.array(z.string()).optional(),
      period: z.string(),
      status: z.string(),
      totals: z.strictObject({ deductions: z.number(), employees: z.number(), employerCost: z.number(), gross: z.number(), held: z.number(), net: z.number() }).nullable(),
    }),
  ),
});

export const GetApprovalsById200 = z.strictObject({
  created_at: z.string(),
  decided_at: z.string().nullable(),
  entity_id: z.string(),
  entity_type: z.string(),
  id: z.string(),
  requester_id: z.string(),
  status: z.string(),
  steps: z.array(
    z.strictObject({
      acted_at: z.string().nullable(),
      acted_by_name: z.string(),
      acted_for_name: z.string(),
      acted_via: z.string().nullable(),
      approver_kind: z.string(),
      approver_name: z.string(),
      approver_permission: z.string().nullable().optional(),
      comment: z.string().nullable().optional(),
      escalated_at: z.string().nullable(),
      escalated_permission: z.string().nullable().optional(),
      escalated_to_name: z.string().nullable(),
      status: z.string(),
      step_index: z.number(),
    }),
  ),
  summary: z.string(),
});

export const GetApprovalsDelegates200 = z.strictObject({
  items: z.array(z.strictObject({ code: z.string().nullable(), designation: z.string().nullable(), id: z.string(), name: z.string() })),
});

export const GetApprovalsDelegations200 = z.strictObject({
  given: z
    .array(
      z.strictObject({
        created_at: z.string(),
        created_by_name: z.string(),
        delegate_id: z.string(),
        delegate_name: z.string(),
        delegator_id: z.string(),
        delegator_name: z.string(),
        ends_on: z.string(),
        id: z.string(),
        note: z.string().nullable(),
        revoked_at: z.string().nullable(),
        set_up_by_hr: z.boolean(),
        starts_on: z.string(),
        state: z.string(),
      }),
    )
    .optional(),
  items: z
    .array(
      z.strictObject({
        created_at: z.string(),
        created_by_name: z.string(),
        delegate_id: z.string(),
        delegate_name: z.string(),
        delegator_id: z.string(),
        delegator_name: z.string(),
        ends_on: z.string(),
        id: z.string(),
        note: z.string().nullable(),
        revoked_at: z.string().nullable(),
        set_up_by_hr: z.boolean(),
        starts_on: z.string(),
        state: z.string(),
      }),
    )
    .optional(),
  received: z
    .array(
      z.strictObject({
        created_at: z.string(),
        created_by_name: z.string(),
        delegate_id: z.string(),
        delegate_name: z.string(),
        delegator_id: z.string(),
        delegator_name: z.string(),
        ends_on: z.string(),
        id: z.string(),
        note: z.string().nullable(),
        revoked_at: z.string().nullable(),
        set_up_by_hr: z.boolean(),
        starts_on: z.string(),
        state: z.string(),
      }),
    )
    .optional(),
  today: z.string(),
});

export const GetApprovalsInbox200 = z.strictObject({
  items: z.array(
    z.strictObject({
      approver_kind: z.string(),
      approver_name: z.string().nullable(),
      approver_permission: z.string().nullable(),
      approver_user_id: z.string().nullable(),
      created_at: z.string(),
      current_step: z.number(),
      delegated_by: z.string().nullable(),
      entity_id: z.string(),
      entity_type: z.string(),
      escalated_at: z.string().nullable(),
      escalated_permission: z.string().nullable(),
      escalated_to: z.string().nullable(),
      id: z.string(),
      on_behalf_of: z.string().nullable(),
      requester_name: z.string(),
      summary: z.string(),
      via: z.string().nullable(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetApprovalsMine200 = z.strictObject({
  items: z.array(
    z.strictObject({
      created_at: z.string(),
      decided_at: z.string().nullable(),
      entity_id: z.string(),
      entity_type: z.string(),
      id: z.string(),
      status: z.string(),
      summary: z.string(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetApprovalsStuck200 = z.strictObject({
  items: z.array(z.strictObject({ created_at: z.string(), entity_id: z.string(), entity_type: z.string(), id: z.string(), requester_name: z.string(), summary: z.string() })),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetAssets200 = z.strictObject({
  items: z.array(
    z.strictObject({
      acknowledged_at: z.string().nullable(),
      branch_id: z.string().nullable(),
      branch_name: z.string().nullable(),
      calibration_due: z.string().nullable(),
      category: z.string(),
      due_back: z.string().nullable(),
      holder_id: z.string().nullable(),
      holder_name: z.string().nullable(),
      id: z.string(),
      issued_at: z.string().nullable(),
      name: z.string(),
      notes: z.string().nullable(),
      purchase_date: z.string().nullable(),
      serial_number: z.string().nullable(),
      status: z.string(),
      tag: z.string(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  today: z.string(),
  total: z.number(),
});

export const GetAssetsByIdHistory200 = z.strictObject({
  items: z.array(
    z.strictObject({
      acknowledged_at: z.string().nullable(),
      condition_in: z.string().nullable(),
      condition_out: z.string().nullable(),
      due_back: z.string().nullable(),
      employee_code: z.string(),
      employee_name: z.string(),
      id: z.string(),
      issued_at: z.string(),
      issued_by_name: z.string(),
      outcome: z.string().nullable(),
      received_by_name: z.string().nullable(),
      returned_at: z.string().nullable(),
    }),
  ),
});

export const GetAssetsMine200 = z.strictObject({
  items: z.array(
    z.strictObject({
      acknowledged_at: z.string().nullable(),
      category: z.string(),
      condition_out: z.string().nullable(),
      due_back: z.string().nullable(),
      id: z.string(),
      issued_at: z.string(),
      name: z.string(),
      serial_number: z.string().nullable(),
      tag: z.string(),
    }),
  ),
});

export const GetAttendanceDaily200 = z.strictObject({
  items: z.array(
    z.strictObject({
      branch_name: z.string(),
      early_exit_minutes: z.number().nullable(),
      employee_code: z.string(),
      employee_id: z.string(),
      exceptions: z.array(z.string()).nullable(),
      first_in: z.string().nullable(),
      last_out: z.string().nullable(),
      late_minutes: z.number().nullable(),
      locked: z.boolean().nullable(),
      name: z.string(),
      overtime_minutes: z.number().nullable(),
      selfie_id: z.string().nullable().optional(),
      shift_code: z.string().nullable(),
      status: z.string(),
      worked_minutes: z.number().nullable(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  summary: z.array(z.strictObject({ count: z.number(), status: z.string() })),
  total: z.number(),
});

export const GetAttendanceDeviceEventsUnmapped200 = z.strictObject({
  items: z.array(
    z.strictObject({
      device_name: z.string(),
      device_time: z.string().nullable(),
      device_user_id: z.string().nullable(),
      direction: z.string(),
      event_time: z.string(),
      id: z.string(),
      received_at: z.string(),
      serial_number: z.string(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetAttendanceDeviceMappings200 = z.strictObject({
  items: z.array(z.strictObject({ device_user_id: z.string(), employee_code: z.string(), employee_id: z.string(), name: z.string() })),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetAttendanceDevices200 = z.strictObject({
  items: z.array(
    z.strictObject({
      adapter_key: z.string(),
      api_key_prefix: z.string(),
      branch_id: z.string(),
      branch_name: z.string(),
      id: z.string(),
      last_clock_drift_seconds: z.number().nullable(),
      last_error: z.string().nullable(),
      last_sync_at: z.string().nullable(),
      name: z.string(),
      serial_number: z.string(),
      status: z.string(),
      unmapped_events: z.number(),
    }),
  ),
});

export const GetAttendanceEmployeesById200 = z.strictObject({
  days: z.array(
    z.strictObject({
      calc_version: z.number(),
      day_type: z.string(),
      duty_fraction: z.string(),
      early_exit_minutes: z.number(),
      exceptions: z.array(z.string()),
      first_in: z.string().nullable(),
      last_out: z.string().nullable(),
      late_minutes: z.number(),
      leave_fraction: z.string(),
      leave_type_code: z.string().nullable(),
      locked: z.boolean(),
      overtime_minutes: z.number(),
      punch_count: z.number(),
      shift_code: z.string(),
      status: z.string(),
      work_date: z.string(),
      worked_minutes: z.number(),
    }),
  ),
  events: z.array(z.strictObject({ device_time: z.string().nullable(), direction: z.string(), event_time: z.string(), id: z.string(), source: z.string(), status: z.string() })),
  timezone: z.string(),
});

export const GetAttendanceGeofences200 = z.strictObject({
  items: z.array(z.strictObject({ branch_id: z.string(), branch_name: z.string(), latitude: z.string(), longitude: z.string(), radius_m: z.number(), updated_at: z.string() })),
});

export const GetAttendanceHolidays200 = z.strictObject({
  items: z.array(
    z.strictObject({ branch_id: z.string().nullable(), branch_name: z.string().nullable(), holiday_date: z.string(), id: z.string(), name: z.string(), optional: z.boolean() }),
  ),
});

export const GetAttendanceLocks200 = z.strictObject({
  items: z.array(z.strictObject({ id: z.string(), locked_at: z.string(), locked_by: z.string(), period_end: z.string(), period_start: z.string() })),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetAttendanceMe200 = z.strictObject({
  days: z.array(
    z.strictObject({
      calc_version: z.number(),
      day_type: z.string(),
      duty_fraction: z.string(),
      early_exit_minutes: z.number(),
      exceptions: z.array(z.string()),
      first_in: z.string().nullable(),
      last_out: z.string().nullable(),
      late_minutes: z.number(),
      leave_fraction: z.string(),
      leave_type_code: z.string().nullable().optional(),
      locked: z.boolean(),
      overtime_minutes: z.number(),
      punch_count: z.number(),
      shift_code: z.string(),
      status: z.string(),
      work_date: z.string(),
      worked_minutes: z.number(),
    }),
  ),
  events: z.array(
    z.strictObject({ device_time: z.string().nullable().optional(), direction: z.string(), event_time: z.string(), id: z.string(), source: z.string(), status: z.string() }),
  ),
  timezone: z.string(),
});

export const GetAttendanceMeToday200 = z.union([AttendanceMeTodayLinked, z.strictObject({ linked: z.literal(false) })]);

export const GetAttendanceRegularizations200 = z.strictObject({
  items: z.array(
    z.strictObject({
      approval_request_id: z.string(),
      created_at: z.string(),
      decided_at: z.string().nullable(),
      employee_code: z.string(),
      id: z.string(),
      name: z.string(),
      reason: z.string(),
      requested_in: z.string().nullable(),
      requested_out: z.string().nullable(),
      status: z.string(),
      work_date: z.string(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetAttendanceRoster200 = z.strictObject({
  canEdit: z.boolean(),
  dates: z.array(z.string()),
  from: z.string(),
  items: z.array(
    z.strictObject({
      code: z.string(),
      days: z.array(
        z.strictObject({
          date: z.string(),
          holiday: z.string().nullable(),
          off: z.boolean(),
          pattern: z.string().nullable(),
          reason: z.string().nullable(),
          shiftId: z.string().nullable(),
          source: z.string(),
        }),
      ),
      department: z.string(),
      id: z.string(),
      name: z.string(),
    }),
  ),
  shifts: z.array(z.strictObject({ code: z.string(), end_time: z.string(), id: z.string(), name: z.string(), start_time: z.string() })),
  to: z.string(),
});

export const GetAttendanceRosterPatterns200 = z.strictObject({
  items: z.array(
    z.strictObject({
      code: z.string(),
      days: z.array(z.string().nullable()),
      employees: z.number(),
      id: z.string(),
      name: z.string(),
      status: z.string(),
      updated_at: z.string(),
      used: z.boolean(),
    }),
  ),
});

export const GetAttendanceShifts200 = z.strictObject({
  items: z.array(
    z.strictObject({
      break_minutes: z.number(),
      code: z.string(),
      early_exit_grace_minutes: z.number(),
      end_time: z.string(),
      full_day_min_minutes: z.number(),
      grace_minutes: z.number(),
      half_day_min_minutes: z.number(),
      id: z.string(),
      name: z.string(),
      overnight: z.boolean(),
      overtime_after_minutes: z.number().nullable(),
      start_time: z.string(),
      status: z.string(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetAuthMe200 = z.strictObject({
  capabilities: z.record(z.string(), z.boolean()),
  csrfToken: z.string(),
  mfa: z.strictObject({ enabled: z.boolean(), enrollmentRequired: z.boolean(), method: z.string().nullable(), pending: z.boolean(), suggested: z.boolean() }),
  mode: z.string(),
  organization: z.strictObject({ id: z.string(), name: z.string() }),
  passwordChangeRequired: z.boolean(),
  permissions: z.array(z.string()),
  preferences: z.strictObject({ dateFormat: z.string(), emailNotifications: z.boolean(), timezone: z.string() }).nullable(),
  roles: z.array(z.strictObject({ group: z.string(), key: z.string(), name: z.string() })),
  salaryLevel: z.number(),
  user: z.strictObject({ displayName: z.string(), email: z.string(), employeeId: z.string().nullable(), id: z.string() }),
  views: z.array(z.strictObject({ key: z.string(), label: z.string() })),
});

export const GetAuthMfaMethods200 = z.strictObject({
  enabled: z.boolean(),
  enforced: z.boolean(),
  method: z.string().nullable().optional(),
  methods: z.array(z.strictObject({ method: z.string(), reason: z.string().optional(), usable: z.boolean() })),
  recoveryCodesLeft: z.number(),
});

export const GetAuthSessions200 = z.strictObject({
  items: z.array(
    z.strictObject({
      created_at: z.string(),
      current: z.boolean(),
      expires_at: z.string(),
      id: z.string(),
      ip: z.string().nullable(),
      last_seen_at: z.string(),
      mfa_verified: z.boolean(),
      user_agent: z.string().nullable(),
    }),
  ),
});

export const GetCases200 = z.strictObject({
  items: z.array(
    z.strictObject({
      anonymous: z.boolean(),
      assignee_name: z.string().nullable(),
      category: z.string(),
      closed_at: z.string().nullable(),
      complainant_name: z.string().nullable(),
      id: z.string(),
      inquiry_due: z.string().nullable(),
      kind: z.string(),
      number: z.number(),
      received_at: z.string(),
      reference: z.string(),
      report_due: z.string().nullable(),
      sla_due: z.string().nullable(),
      status: z.string(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetCasesById200 = z.strictObject({
  allowedMoves: z.array(z.string()),
  anonymous: z.boolean(),
  assigneeName: z.string().nullable(),
  category: z.string(),
  closedAt: z.string().nullable(),
  complainantName: z.string().nullable(),
  description: z.string(),
  events: z.array(
    z.strictObject({
      actor: z.string(),
      at: z.string(),
      from_status: z.string().nullable(),
      text: z.string().nullable(),
      to_status: z.string().nullable(),
      type: z.string(),
      visible_to_complainant: z.boolean(),
    }),
  ),
  id: z.string(),
  incidentDate: z.string().nullable(),
  inquiryDue: z.string().nullable(),
  kind: z.string(),
  lateReason: z.string().nullable(),
  outcome: z.string().nullable(),
  receivedAt: z.string(),
  reference: z.string(),
  reportDue: z.string().nullable(),
  respondentName: z.string().nullable().optional(),
  respondentText: z.string().nullable().optional(),
  role: z.string(),
  slaDue: z.string().nullable(),
  status: z.string(),
  version: z.number(),
});

export const GetCasesCommittee200 = z.strictObject({
  external: z.array(z.strictObject({ id: z.string(), name: z.string(), organization: z.string(), since: z.string(), until: z.string().nullable() })),
  members: z.array(z.strictObject({ added_at: z.string(), display_name: z.string(), role: z.string(), user_id: z.string() })),
  warnings: z.array(z.string()),
});

export const GetCasesPeople200 = z.strictObject({ items: z.array(z.strictObject({ display_name: z.string(), id: z.string() })) });

export const GetCasesPoshAnnualReport200 = z.strictObject({
  disposed: z.number(),
  note: z.string(),
  pending: z.number(),
  pending_over_90: z.number(),
  received: z.number(),
  year: z.number(),
});

export const GetCompetencyAssessments200 = z.strictObject({
  items: z.array(
    z.strictObject({
      activity: z.string(),
      approach: z.string(),
      assessed_on: z.string(),
      assessor_name: z.string(),
      created_at: z.string(),
      employee_code: z.string(),
      employee_id: z.string(),
      employee_name: z.string(),
      evidence: z.string(),
      id: z.string(),
      method_code: z.string(),
      method_id: z.string(),
      method_name: z.string(),
      result: z.string(),
      used: z.boolean(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetCompetencyAuthorizations200 = z.strictObject({
  items: z.array(
    z.strictObject({
      activity: z.string(),
      authorized_at: z.string().nullable(),
      authorized_by_name: z.string(),
      created_at: z.string(),
      employee_code: z.string(),
      employee_id: z.string(),
      employee_name: z.string(),
      end_reason: z.string().nullable(),
      ended_at: z.string().nullable(),
      id: z.string(),
      method_code: z.string(),
      method_id: z.string(),
      method_name: z.string(),
      missing_training: z.number(),
      requested_by_name: z.string(),
      review_due: z.string(),
      standard_ref: z.string().nullable(),
      status: z.string(),
      valid_from: z.string(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetCompetencyAuthorizationsById200 = z.strictObject({
  activity: z.string(),
  assessment: z.strictObject({ approach: z.string(), assessed_on: z.string(), assessor_name: z.string(), evidence: z.string(), result: z.string() }),
  check: z
    .strictObject({ authorizationId: z.string(), authorized: z.boolean(), date: z.string(), reasons: z.array(z.string()), reviewDue: z.string(), status: z.string() })
    .nullable(),
  employee_id: z.string(),
  employee_name: z.string(),
  events: z.array(z.strictObject({ action: z.string(), actor_name: z.string().nullable(), at: z.string(), reason: z.string().nullable() })),
  id: z.string(),
  method_code: z.string(),
  method_id: z.string(),
  method_name: z.string(),
  requested_by: z.string(),
  review_due: z.string().nullable(),
  review_months: z.number(),
  status: z.string(),
  valid_from: z.string().nullable(),
});

export const GetCompetencyCheck200 = z.strictObject({
  activity: z.string(),
  authorizationId: z.string().nullable(),
  authorized: z.boolean(),
  date: z.string(),
  employeeId: z.string(),
  methodCode: z.string(),
  methodId: z.string(),
  reasons: z.array(z.string()),
  reviewDue: z.string().nullable(),
  status: z.string().nullable(),
});

export const GetCompetencyCourses200 = z.strictObject({
  items: z.array(
    z.strictObject({
      code: z.string(),
      description: z.string().nullable(),
      id: z.string(),
      kind: z.string(),
      name: z.string(),
      records: z.number(),
      status: z.string(),
      validity_months: z.number().nullable(),
    }),
  ),
});

export const GetCompetencyMatrix200 = z.strictObject({
  activities: z.array(z.string()),
  date: z.string(),
  methods: z.array(z.strictObject({ code: z.string(), discipline: z.string().nullable(), id: z.string(), matrix: z.string().nullable(), name: z.string() })),
  rows: z.array(
    z.strictObject({
      cells: z.record(z.string(), z.looseObject({ perform: z.looseObject({ inForce: z.boolean(), reviewDue: z.string(), status: z.string() }) })),
      employeeCode: z.string(),
      employeeId: z.string(),
      name: z.string(),
    }),
  ),
});

export const GetCompetencyMe200 = z.strictObject({
  authorizations: z.array(
    z.strictObject({
      activity: z.string(),
      id: z.string(),
      method_code: z.string(),
      method_name: z.string(),
      review_due: z.string(),
      standard_ref: z.string().nullable(),
      status: z.string(),
      valid_from: z.string().nullable(),
    }),
  ),
  date: z.string(),
  training: z.array(
    z.strictObject({
      completed_on: z.string(),
      course_code: z.string(),
      course_name: z.string(),
      expires_on: z.string().nullable(),
      id: z.string(),
      result: z.string(),
      validity: z.string(),
    }),
  ),
});

export const GetCompetencyMethods200 = z.strictObject({
  items: z.array(
    z.strictObject({
      branch_id: z.string().nullable(),
      branch_name: z.string().nullable(),
      code: z.string(),
      discipline: z.string().nullable(),
      id: z.string(),
      matrix: z.string().nullable(),
      name: z.string(),
      requirements: z.array(z.looseObject({ code: z.string(), id: z.string(), name: z.string() })),
      review_months: z.number(),
      standard_ref: z.string().nullable(),
      status: z.string(),
    }),
  ),
});

export const GetCompetencyTrainingRecords200 = z.strictObject({
  items: z.array(
    z.strictObject({
      completed_on: z.string(),
      course_code: z.string(),
      course_id: z.string(),
      course_name: z.string(),
      created_at: z.string(),
      employee_code: z.string(),
      employee_id: z.string(),
      employee_name: z.string(),
      expires_on: z.string().nullable(),
      hours: z.string().nullable(),
      id: z.string(),
      notes: z.string().nullable(),
      provider: z.string().nullable(),
      result: z.string(),
      revoked_reason: z.string().nullable(),
      status: z.string(),
      trainer: z.string().nullable(),
      validity: z.string(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetConfigPublic200 = z.strictObject({
  auth: z.strictObject({ resetByEmail: z.boolean() }),
  brand: z.strictObject({
    accentColor: z.string().nullable().optional(),
    country: z.string(),
    currency: z.string(),
    dateFormat: z.string(),
    domain: z.string(),
    faviconUrl: z.string().nullable(),
    financialYearStart: z.string(),
    fontFamily: z.string().nullable().optional(),
    helpUrl: z.string().nullable().optional(),
    legalName: z.string(),
    locale: z.string(),
    loginMessage: z.string().nullable().optional(),
    logoDarkUrl: z.string().nullable(),
    logoUrl: z.string().nullable(),
    name: z.string(),
    primaryColor: z.string(),
    secondaryColor: z.string().nullable().optional(),
    supportEmail: z.string(),
    supportPhone: z.string().nullable().optional(),
    timezone: z.string(),
  }),
  features: z.record(z.string(), z.boolean()),
  mfa: z.strictObject({ available: z.boolean(), enforced: z.boolean(), methods: z.array(z.string()) }),
  mode: z.string(),
  product: z.strictObject({ name: z.string() }),
});

export const GetDashboard200 = z.strictObject({
  lists: z.array(
    z.strictObject({
      href: z.string().optional(),
      items: z.array(z.strictObject({ date: z.string().optional(), primary: z.string(), secondary: z.string().optional() })),
      key: z.string(),
      more: z.number().optional(),
      title: z.string(),
    }),
  ),
  sections: z.array(
    z.strictObject({
      key: z.string(),
      tiles: z.array(
        z.strictObject({
          detail: z.string().optional(),
          href: z.string(),
          key: z.string(),
          label: z.string(),
          tone: z.string().optional(),
          value: z.union([z.number(), z.string()]),
        }),
      ),
      title: z.string(),
    }),
  ),
  today: z.string(),
});

export const GetDocuments200 = z.strictObject({
  items: z.array(
    z.strictObject({
      category_id: z.string(),
      category_name: z.string(),
      content_type: z.string(),
      created_at: z.string(),
      employee_code: z.string().nullable(),
      employee_id: z.string().nullable(),
      employee_name: z.string().nullable(),
      expires_on: z.string().nullable().optional(),
      file_name: z.string(),
      id: z.string(),
      restricted: z.boolean(),
      size_bytes: z.number(),
      status: z.string(),
      title: z.string(),
      uploaded_by_name: z.string(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetDocumentsCategories200 = z.strictObject({
  items: z.array(
    z.strictObject({
      code: z.string(),
      employee_upload: z.boolean(),
      employee_visible: z.boolean(),
      id: z.string(),
      name: z.string(),
      payroll_related: z.boolean(),
      requires_expiry: z.boolean(),
      restricted: z.boolean(),
      scope: z.string(),
      status: z.string(),
    }),
  ),
});

export const GetEmployees200 = z.strictObject({
  items: z.array(
    z.strictObject({
      branch_id: z.string().optional(),
      branch_name: z.string().optional(),
      confirmation_date: z.string().nullable().optional(),
      contract_end_date: z.string().nullable().optional(),
      created_at: z.string().optional(),
      date_of_birth: z.string().nullable().optional(),
      date_of_joining: z.string().optional(),
      department_id: z.string().nullable(),
      department_name: z.string().nullable(),
      designation: z.string().nullable(),
      employee_code: z.string(),
      employment_type: z.string().optional(),
      exit_date: z.string().nullable().optional(),
      first_name: z.string(),
      grade: z.string().nullable().optional(),
      id: z.string(),
      last_name: z.string().nullable(),
      legal_entity_id: z.string().optional(),
      legal_entity_name: z.string().optional(),
      masked: z.boolean().optional(),
      maskedFields: z.array(z.string()).optional(),
      phone: z.string().nullable().optional(),
      probation_end_date: z.string().nullable().optional(),
      reporting_manager_id: z.string().nullable().optional(),
      reporting_manager_name: z.string().nullable().optional(),
      status: z.string().optional(),
      updated_at: z.string().optional(),
      user_id: z.string().nullable().optional(),
      version: z.number().optional(),
      work_email: z.string().nullable(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
  view: z.string(),
});

export const GetEmployeesById200 = z.looseObject({
  branch_id: z.string().optional(),
  branch_name: z.string().optional(),
  confirmation_date: z.string().nullable().optional(),
  contract_end_date: z.string().nullable().optional(),
  created_at: z.string().optional(),
  date_of_birth: z.string().nullable().optional(),
  date_of_joining: z.string().optional(),
  department_id: z.string().nullable(),
  department_name: z.string().nullable(),
  designation: z.string().nullable(),
  employee_code: z.string(),
  employment_type: z.string().optional(),
  exit_date: z.string().nullable().optional(),
  first_name: z.string(),
  grade: z.string().nullable().optional(),
  id: z.string(),
  last_name: z.string().nullable(),
  legal_entity_id: z.string().optional(),
  legal_entity_name: z.string().optional(),
  masked: z.boolean().optional(),
  maskedFields: z.array(z.string()).optional(),
  phone: z.string().nullable().optional(),
  probation_end_date: z.string().nullable().optional(),
  reporting_manager_id: z.string().nullable().optional(),
  reporting_manager_name: z.string().nullable().optional(),
  status: z.string().optional(),
  updated_at: z.string().optional(),
  user_id: z.string().nullable().optional(),
  version: z.number().optional(),
  view: z.string(),
  work_email: z.string().nullable(),
});

export const GetEmployeesByIdBankAccount200 = z
  .strictObject({
    accountHolder: z.string().nullable(),
    accountNumber: z.string().nullable(),
    accountNumberMasked: z.string(),
    bankName: z.string().nullable().optional(),
    ifsc: z.string().nullable(),
    masked: z.boolean().optional(),
    maskedFields: z.array(z.string()).optional(),
    updatedAt: z.string(),
  })
  .nullable();

export const GetEmployeesByIdBankAccountPending200 = z.strictObject({
  pending: z
    .strictObject({
      accountHolder: z.string(),
      accountNumberMasked: z.string(),
      bankName: z.string().nullable().optional(),
      id: z.string(),
      ifsc: z.string(),
      requestedAt: z.string(),
      requestedBy: z.string(),
    })
    .nullable(),
});

export const GetEmployeesByIdHistory200 = z.strictObject({
  items: z.array(
    z.strictObject({
      action: z.string(),
      actor_name: z.string().nullable(),
      change_metadata: z.record(z.string(), z.unknown()).nullable(),
      created_at: z.string(),
      id: z.string(),
    }),
  ),
});

export const GetEmployeesByIdProfile200 = z.strictObject({
  edit: z.strictObject({ addresses: z.string(), contacts: z.string(), education: z.string(), experience: z.string(), nominees: z.string() }),
  missing: z.array(z.string()),
  pending: z.array(
    z.strictObject({
      approval_id: z.string(),
      created_at: z.string(),
      id: z.string(),
      items: z.array(
        z.looseObject({
          address: z.string().nullable().optional(),
          dateOfBirth: z.string(),
          guardianName: z.string().nullable(),
          name: z.string(),
          purpose: z.string(),
          relationship: z.string(),
          sharePercent: z.number(),
        }),
      ),
      note: z.string().nullable().optional(),
      requested_by_name: z.string(),
      section: z.string(),
    }),
  ),
  sections: z.strictObject({
    addresses: z.array(
      z.strictObject({ city: z.string(), country: z.string(), kind: z.string(), line1: z.string(), line2: z.string().nullable(), postalCode: z.string(), state: z.string() }),
    ),
    contacts: z.array(z.strictObject({ altPhone: z.string().nullable().optional(), name: z.string(), phone: z.string(), relationship: z.string() })),
    education: z.array(
      z.strictObject({
        institution: z.string(),
        level: z.string(),
        qualification: z.string(),
        score: z.string().nullable(),
        university: z.string().nullable(),
        yearOfPassing: z.number().nullable(),
      }),
    ),
    experience: z.array(z.strictObject({ designation: z.string(), employer: z.string(), fromDate: z.string(), reasonForLeaving: z.string().nullable(), toDate: z.string() })),
    nominees: z.array(
      z.strictObject({
        address: z.string().nullable().optional(),
        dateOfBirth: z.string().nullable(),
        guardianName: z.string().nullable(),
        name: z.string(),
        purpose: z.string(),
        relationship: z.string(),
        sharePercent: z.number(),
      }),
    ),
  }),
});

export const GetEmployeesMe200 = z.looseObject({
  branch_id: z.string(),
  branch_name: z.string(),
  confirmation_date: z.string().nullable().optional(),
  contract_end_date: z.string().nullable(),
  created_at: z.string(),
  date_of_birth: z.string().nullable(),
  date_of_joining: z.string(),
  department_id: z.string().nullable(),
  department_name: z.string(),
  designation: z.string().nullable(),
  employee_code: z.string(),
  employment_type: z.string(),
  exit_date: z.string().nullable(),
  first_name: z.string(),
  grade: z.string().nullable(),
  id: z.string(),
  last_name: z.string().nullable(),
  legal_entity_id: z.string(),
  legal_entity_name: z.string(),
  phone: z.string().nullable(),
  probation_end_date: z.string().nullable().optional(),
  reporting_manager_id: z.string().nullable(),
  reporting_manager_name: z.string().nullable(),
  status: z.string(),
  updated_at: z.string(),
  user_id: z.string(),
  version: z.number(),
  work_email: z.string().nullable(),
});

export const GetEmployeesProfileChangesByChangeId200 = z.strictObject({
  created_at: z.string(),
  current: z.array(z.record(z.string(), z.unknown())),
  decided_at: z.string().nullable(),
  employee_code: z.string(),
  employee_id: z.string(),
  employee_name: z.string(),
  id: z.string(),
  items: z.array(
    z.looseObject({
      address: z.string().nullable(),
      dateOfBirth: z.string(),
      guardianName: z.string().nullable(),
      name: z.string(),
      purpose: z.string(),
      relationship: z.string(),
      sharePercent: z.number(),
    }),
  ),
  note: z.string().nullable(),
  section: z.string(),
  status: z.string(),
});

export const GetExpensesAllowanceQuote200 = z.strictObject({
  amount: z.string().optional(),
  gradeSpecific: z.boolean().optional(),
  quantity: z.number().optional(),
  rate: z.string().nullable(),
});

export const GetExpensesAllowanceRates200 = z.strictObject({
  canManage: z.boolean(),
  items: z.array(
    z.strictObject({
      created_at: z.string(),
      created_by_name: z.string(),
      effective_from: z.string(),
      grade: z.string().nullable(),
      id: z.string(),
      kind: z.string(),
      note: z.string().nullable(),
      rate: z.string(),
      state: z.string(),
      tier: z.string().nullable(),
      vehicle: z.string().nullable(),
    }),
  ),
  tiers: z.array(z.string()),
  today: z.string(),
  vehicles: z.strictObject({ car: z.string(), two_wheeler: z.string() }),
});

export const GetExpensesBatches200 = z.strictObject({
  items: z.array(
    z.strictObject({
      approved_at: z.string().nullable(),
      approved_by: z.string().nullable(),
      approved_by_name: z.string().nullable(),
      claim_count: z.number(),
      created_at: z.string(),
      id: z.string(),
      paid_at: z.string().nullable(),
      paid_by: z.string().nullable(),
      paid_by_name: z.string().nullable(),
      payment_reference: z.string().nullable(),
      prepared_by: z.string(),
      prepared_by_name: z.string(),
      status: z.string(),
      tenant_id: z.string(),
      total: z.string(),
    }),
  ),
});

export const GetExpensesCategories200 = z.strictObject({
  items: z.array(
    z.strictObject({
      calc: z.string().nullable(),
      code: z.string(),
      description: z.string().nullable(),
      gst_applicable: z.boolean(),
      id: z.string(),
      max_amount: z.string().nullable(),
      name: z.string(),
      requires_receipt: z.boolean(),
      status: z.string(),
    }),
  ),
});

export const GetExpensesClaims200 = z.strictObject({
  items: z.array(
    z.strictObject({
      advance_adjusted: z.string(),
      approved_at: z.string().nullable(),
      created_at: z.string(),
      currency: z.string(),
      employee_code: z.string(),
      employee_id: z.string(),
      employee_name: z.string(),
      flagged: z.number(),
      id: z.string(),
      items: z.number(),
      paid_at: z.string().nullable(),
      payment_reference: z.string().nullable(),
      status: z.string(),
      submitted_at: z.string().nullable(),
      title: z.string(),
      total: z.string(),
      travel_request_id: z.string().nullable(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetExpensesClaimsById200 = z.strictObject({
  advance_adjusted: z.string().optional(),
  approval_request_id: z.string().nullable(),
  approved_at: z.string().nullable(),
  batch_id: z.string().nullable(),
  created_at: z.string(),
  created_by: z.string(),
  currency: z.string(),
  editable: z.boolean(),
  employee_code: z.string(),
  employee_id: z.string(),
  employee_name: z.string(),
  id: z.string(),
  items: z.array(
    z.strictObject({
      amount: z.string(),
      calc: z.string().nullable(),
      category_code: z.string(),
      category_name: z.string(),
      description: z.string(),
      duplicate_of: z.string().nullable().optional(),
      expense_date: z.string(),
      gstin: z.string().nullable().optional(),
      has_receipt: z.boolean(),
      id: z.string(),
      invoice_number: z.string().nullable().optional(),
      merchant: z.string().nullable().optional(),
      quantity: z.string().nullable(),
      rate: z.string().nullable(),
      receipt_name: z.string().nullable(),
      tier: z.string().nullable(),
      vehicle: z.string().nullable(),
    }),
  ),
  paid_at: z.string().nullable(),
  payment_reference: z.string().nullable(),
  project: z.string().nullable(),
  purpose: z.string(),
  status: z.string(),
  submitted_at: z.string().nullable(),
  tenant_id: z.string(),
  title: z.string(),
  total: z.string(),
  travel_request_id: z.string().nullable().optional(),
  updated_at: z.string(),
  version: z.number(),
});

export const GetExpensesPayables200 = z.strictObject({
  items: z.array(
    z.strictObject({
      advance_adjusted: z.string(),
      age_days: z.number(),
      approved_at: z.string().nullable(),
      employee_code: z.string(),
      employee_name: z.string(),
      id: z.string(),
      payable: z.string(),
      title: z.string(),
      total: z.string(),
    }),
  ),
});

export const GetExpensesReportsAgeing200 = z.strictObject({
  approvedUnpaidByAge: z.array(z.strictObject({ amount: z.string(), bucket: z.string(), claims: z.number() })),
  last3MonthsByCategory: z.array(z.strictObject({ amount: z.string(), items: z.number(), name: z.string() })),
  pipeline: z.array(z.strictObject({ amount: z.string(), claims: z.number(), status: z.string() })),
});

export const GetFieldDutyRequests200 = z.strictObject({
  items: z.array(
    z.strictObject({
      approval_request_id: z.string().nullable(),
      cancel_reason: z.string().nullable().optional(),
      client_name: z.string().nullable(),
      created_at: z.string(),
      day_part: z.string(),
      decided_at: z.string().nullable(),
      department: z.string().nullable(),
      employee_code: z.string(),
      employee_id: z.string(),
      end_date: z.string(),
      id: z.string(),
      masked: z.boolean().optional(),
      maskedFields: z.array(z.string()).optional(),
      name: z.string(),
      outcome: z.string().nullable(),
      outcome_note: z.string().nullable(),
      place: z.string(),
      purpose: z.string(),
      reason: z.string().nullable(),
      recorded_by_other: z.boolean(),
      reference: z.string().nullable(),
      reported_at: z.string().nullable(),
      start_date: z.string(),
      status: z.string(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  today: z.string(),
  total: z.number(),
});

export const GetFieldDutyRequestsById200 = z.strictObject({
  approval_request_id: z.string().nullable(),
  cancel_reason: z.string().nullable().optional(),
  client_name: z.string().nullable(),
  created_at: z.string(),
  day_part: z.string(),
  decided_at: z.string().nullable(),
  department: z.string().nullable(),
  employee_code: z.string(),
  employee_id: z.string(),
  end_date: z.string(),
  id: z.string(),
  masked: z.boolean().optional(),
  maskedFields: z.array(z.string()).optional(),
  name: z.string(),
  outcome: z.string().nullable(),
  outcome_note: z.string().nullable(),
  place: z.string(),
  purpose: z.string(),
  reason: z.string().nullable(),
  recorded_by_other: z.boolean(),
  reference: z.string().nullable(),
  reported_at: z.string().nullable(),
  start_date: z.string(),
  status: z.string(),
});

export const GetLeaveBalances200 = z.strictObject({
  employeeId: z.string(),
  items: z.array(
    z.strictObject({
      accrual_method: z.string(),
      allow_half_day: z.boolean(),
      annual_entitlement: z.string(),
      available: z.string(),
      balance: z.string(),
      code: z.string(),
      id: z.string(),
      name: z.string(),
      paid: z.boolean(),
      pending: z.string(),
      requires_balance: z.boolean(),
      used: z.string(),
    }),
  ),
  leaveYear: z.number(),
  period: z.strictObject({ end: z.string(), start: z.string() }),
});

export const GetLeaveCalendar200 = z.strictObject({
  items: z.array(
    z.strictObject({
      days: z.string(),
      employee_code: z.string(),
      employee_id: z.string(),
      end_date: z.string(),
      end_half: z.string(),
      id: z.string(),
      name: z.string(),
      start_date: z.string(),
      start_half: z.string(),
      status: z.string(),
      type_code: z.string(),
    }),
  ),
});

export const GetLeaveLedger200 = z.strictObject({
  items: z.array(
    z.strictObject({
      created_at: z.string(),
      created_by_name: z.string(),
      days: z.string(),
      entry_type: z.string(),
      id: z.string(),
      note: z.string().nullable(),
      request_id: z.string().nullable(),
    }),
  ),
});

export const GetLeaveRequests200 = z.strictObject({
  items: z.array(
    z.strictObject({
      approval_request_id: z.string().nullable(),
      created_at: z.string(),
      days: z.string(),
      decided_at: z.string().nullable(),
      employee_code: z.string(),
      employee_id: z.string(),
      end_date: z.string(),
      end_half: z.string(),
      id: z.string(),
      masked: z.boolean().optional(),
      maskedFields: z.array(z.string()).optional(),
      name: z.string(),
      reason: z.string().nullable(),
      start_date: z.string(),
      start_half: z.string(),
      status: z.string(),
      type_code: z.string(),
      type_name: z.string(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetLeaveTypes200 = z.strictObject({
  items: z.array(
    z.strictObject({
      accrual_method: z.string(),
      allow_half_day: z.boolean(),
      annual_entitlement: z.string(),
      applicable_employment_types: z.array(z.string()),
      carry_forward_max: z.string(),
      code: z.string(),
      count_non_working_days: z.boolean(),
      description: z.string().nullable().optional(),
      eligible_after_days: z.number(),
      id: z.string(),
      max_balance: z.string().nullable(),
      max_consecutive_days: z.string().nullable().optional(),
      min_notice_days: z.number(),
      name: z.string(),
      paid: z.boolean(),
      requires_balance: z.boolean(),
      status: z.string(),
      version: z.number(),
    }),
  ),
});

export const GetLifecycleChecklists200 = z.strictObject({
  items: z.array(
    z.strictObject({
      anchor_date: z.string(),
      created_at: z.string(),
      done: z.number(),
      employee_code: z.string(),
      employee_id: z.string(),
      employee_name: z.string(),
      id: z.string(),
      kind: z.string(),
      overdue: z.number(),
      status: z.string(),
      tasks: z.number(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetLifecycleChecklistsById200 = z.strictObject({
  anchor_date: z.string(),
  employee: z.strictObject({ id: z.string(), name: z.string(), status: z.string() }),
  employee_id: z.string(),
  id: z.string(),
  kind: z.string(),
  separation_id: z.string().nullable(),
  status: z.string(),
  tasks: z.array(
    z.strictObject({
      canAct: z.boolean(),
      description: z.string().nullable(),
      done_at: z.string().nullable(),
      done_by_name: z.string().nullable(),
      due_date: z.string(),
      id: z.string(),
      note: z.string().nullable(),
      owner: z.string(),
      position: z.number(),
      status: z.string(),
      title: z.string(),
    }),
  ),
});

export const GetLifecycleProbation200 = z.strictObject({
  items: z.array(
    z.strictObject({
      comments: z.string().nullable(),
      date_of_joining: z.string(),
      decided_at: z.string().nullable(),
      designation: z.string().nullable(),
      employee_code: z.string(),
      employee_id: z.string(),
      employee_name: z.string(),
      extend_months: z.number().nullable(),
      id: z.string(),
      probation_end: z.string(),
      recommendation: z.string().nullable(),
      status: z.string(),
      submitted_at: z.string().nullable(),
      submitted_by_name: z.string().nullable(),
    }),
  ),
});

export const GetLifecycleSeparations200 = z.strictObject({
  items: z.array(
    z.strictObject({
      approved_lwd: z.string().nullable(),
      created_at: z.string(),
      designation: z.string().nullable(),
      employee_code: z.string(),
      employee_id: z.string(),
      employee_name: z.string(),
      fnf_status: z.string(),
      id: z.string(),
      kind: z.string(),
      notice_date: z.string(),
      requested_lwd: z.string(),
      shortfall_days: z.number(),
      status: z.string(),
      waive_shortfall: z.boolean(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetLifecycleSeparationsById200 = z.strictObject({
  approved_lwd: z.string().nullable(),
  checklist: z
    .strictObject({
      anchor_date: z.string(),
      employee: z.strictObject({ id: z.string(), name: z.string(), status: z.string() }),
      employee_id: z.string(),
      id: z.string(),
      kind: z.string(),
      separation_id: z.string().nullable(),
      status: z.string(),
      tasks: z.array(
        z.strictObject({
          canAct: z.boolean(),
          description: z.string().nullable(),
          done_at: z.string().nullable(),
          done_by_name: z.string().nullable(),
          due_date: z.string(),
          id: z.string(),
          note: z.string().nullable(),
          owner: z.string(),
          position: z.number(),
          status: z.string(),
          title: z.string(),
        }),
      ),
    })
    .nullable(),
  completed_at: z.string().nullable(),
  created_at: z.string(),
  employee: z.strictObject({ id: z.string(), name: z.string(), status: z.string() }),
  employee_id: z.string(),
  exit_interview: z.strictObject({ _at: z.string(), _recorded_by: z.string(), reason: z.string(), wouldReturn: z.string() }).nullable().optional(),
  fnf_note: z.string().nullable(),
  fnf_status: z.string(),
  id: z.string(),
  initiated_by: z.string(),
  initiated_by_name: z.string(),
  kind: z.string(),
  leaveBalances: z.array(z.strictObject({ balance: z.string(), code: z.string(), name: z.string(), paid: z.boolean() })),
  masked: z.boolean().optional(),
  maskedFields: z.array(z.string()).optional(),
  notice_date: z.string(),
  notice_days_required: z.number(),
  reason: z.string().nullable(),
  rehire_eligible: z.boolean().nullable(),
  requested_lwd: z.string(),
  shortfall_days: z.number(),
  status: z.string(),
  tenant_id: z.string(),
  waive_shortfall: z.boolean(),
});

export const GetLifecycleTasksMine200 = z.strictObject({
  date: z.string(),
  items: z.array(
    z.strictObject({
      checklist_id: z.string(),
      description: z.string().nullable(),
      due_date: z.string(),
      employee_id: z.string(),
      employee_name: z.string(),
      id: z.string(),
      kind: z.string(),
      owner: z.string(),
      title: z.string(),
    }),
  ),
});

export const GetLifecycleTemplates200 = z.strictObject({
  items: z.array(
    z.strictObject({
      id: z.string(),
      is_default: z.boolean(),
      kind: z.string(),
      name: z.string(),
      status: z.string(),
      tasks: z.array(z.looseObject({ description: z.string().nullable(), offsetDays: z.number(), owner: z.string(), title: z.string() })),
    }),
  ),
});

export const GetLoansRequests200 = z.strictObject({
  items: z.array(
    z.strictObject({
      amount: z.string().nullable(),
      approval_request_id: z.string().nullable().optional(),
      cancel_reason: z.string().nullable().optional(),
      closed_at: z.string().nullable().optional(),
      created_at: z.string(),
      decided_at: z.string().nullable(),
      department: z.string().nullable(),
      disbursed_at: z.string().nullable(),
      disbursement_reference: z.string().nullable(),
      employee_code: z.string(),
      employee_id: z.string(),
      first_period: z.string().nullable(),
      id: z.string(),
      installment_amount: z.string().nullable(),
      installments: z.number().nullable(),
      kind: z.string(),
      masked: z.boolean().optional(),
      maskedFields: z.array(z.string()).optional(),
      name: z.string(),
      outstanding: z.string().nullable(),
      purpose: z.string().nullable(),
      recorded_by_other: z.boolean().nullable(),
      skip_periods: z.array(z.string()).nullable(),
      status: z.string(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetLoansRequestsById200 = z.looseObject({
  amount: z.string().nullable(),
  approval_request_id: z.string().nullable(),
  balance: z.looseObject({ amount: z.string(), inProgress: z.string(), outstanding: z.string(), recovered: z.string() }).nullable(),
  cancel_reason: z.string().nullable(),
  closed_at: z.string().nullable(),
  created_at: z.string(),
  decided_at: z.string().nullable(),
  department: z.string().nullable(),
  disbursed_at: z.string().nullable(),
  disbursement_reference: z.string().nullable(),
  employee_code: z.string(),
  employee_id: z.string(),
  first_period: z.string().nullable(),
  id: z.string(),
  installment_amount: z.string().nullable(),
  installments: z.number().nullable(),
  kind: z.string(),
  masked: z.boolean().optional(),
  maskedFields: z.array(z.string()).optional(),
  name: z.string(),
  outstanding: z.string().nullable(),
  purpose: z.string().nullable(),
  recorded_by_other: z.boolean(),
  recoveries: z
    .array(
      z.looseObject({
        amount: z.string(),
        created_at: z.string(),
        id: z.string(),
        period: z.string().nullable(),
        reference: z.string().nullable(),
        run_kind: z.string().nullable(),
        run_status: z.string().nullable(),
        source: z.string(),
      }),
    )
    .nullable(),
  schedule: z.array(z.looseObject({ amount: z.string(), period: z.string().nullable() })).nullable(),
  skip_periods: z.array(z.string()).nullable(),
  status: z.string(),
});

export const GetNotifications200 = z.strictObject({
  items: z.array(
    z.strictObject({
      body: z.string().nullable(),
      created_at: z.string(),
      id: z.string(),
      kind: z.string(),
      link: z.string().nullable(),
      read_at: z.string().nullable(),
      title: z.string(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetNotificationsPushPublicKey200 = z.strictObject({ publicKey: z.string() });

export const GetNotificationsUnreadCount200 = z.strictObject({ unread: z.number() });

export const GetOrg200 = z.strictObject({
  branches: z.array(
    z.strictObject({ city: z.string().nullable(), code: z.string(), id: z.string(), legal_entity_id: z.string(), name: z.string(), state: z.string(), status: z.string() }),
  ),
  departments: z.array(z.strictObject({ code: z.string(), id: z.string(), name: z.string(), parent_id: z.string().nullable(), status: z.string() })),
  designations: z.array(z.strictObject({ code: z.string(), id: z.string(), name: z.string(), status: z.string() })),
  grades: z.array(z.strictObject({ code: z.string(), id: z.string(), name: z.string(), status: z.string() })),
  legalEntities: z.array(
    z.strictObject({ cin: z.string().nullable(), gstin: z.string().nullable(), id: z.string(), name: z.string(), state_code: z.string().nullable(), status: z.string() }),
  ),
});

export const GetOvertimeClaims200 = z.strictObject({
  items: z.array(
    z.strictObject({
      approval_request_id: z.string().nullable(),
      cancel_reason: z.string().nullable().optional(),
      comp_off_days: z.string().nullable(),
      created_at: z.string(),
      decided_at: z.string().nullable(),
      employee_code: z.string(),
      employee_id: z.string(),
      id: z.string(),
      masked: z.boolean().optional(),
      maskedFields: z.array(z.string()).optional(),
      minutes: z.number(),
      name: z.string(),
      payout: z.string(),
      payroll_period: z.string().nullable(),
      payroll_run_id: z.string().nullable(),
      payroll_status: z.string().nullable(),
      reason: z.string().nullable(),
      recorded_minutes: z.number(),
      status: z.string(),
      user_id: z.string(),
      work_date: z.string(),
    }),
  ),
  minutesByStatus: z.strictObject({ approved: z.number().optional(), pending: z.number().optional() }),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetOvertimeClaimsById200 = z.strictObject({
  approval_request_id: z.string().nullable(),
  cancel_reason: z.string().nullable().optional(),
  comp_off_days: z.string().nullable(),
  created_at: z.string(),
  decided_at: z.string().nullable(),
  employee_code: z.string(),
  employee_id: z.string(),
  id: z.string(),
  masked: z.boolean().optional(),
  maskedFields: z.array(z.string()).optional(),
  minutes: z.number(),
  name: z.string(),
  payout: z.string(),
  payroll_period: z.string().nullable().optional(),
  payroll_run_id: z.string().nullable().optional(),
  payroll_status: z.string().nullable().optional(),
  reason: z.string().nullable(),
  recorded_minutes: z.number(),
  status: z.string(),
  user_id: z.string(),
  work_date: z.string(),
});

export const GetOvertimeEligible200 = z.strictObject({
  items: z.array(
    z.strictObject({
      first_in: z.string().nullable(),
      last_out: z.string().nullable(),
      overtime_minutes: z.number(),
      shift_code: z.string().nullable(),
      work_date: z.string(),
      worked_minutes: z.number(),
    }),
  ),
  minMinutes: z.number(),
  payout: z.strictObject({
    compOff: z.strictObject({ code: z.string(), dayMinutes: z.number(), name: z.string() }).nullable(),
    pay: z.boolean(),
    payBlocker: z.string().nullable(),
  }),
  windowDays: z.number(),
});

export const GetPayrollComponents200 = z.strictObject({
  items: z.array(
    z.strictObject({
      base_codes: z.array(z.string()),
      calc: z.string(),
      code: z.string(),
      esi_wage: z.boolean(),
      id: z.string(),
      kind: z.string(),
      name: z.string(),
      pf_wage: z.boolean(),
      position: z.number(),
      prorate: z.boolean(),
      status: z.string(),
      taxable: z.boolean(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetPayrollEmployeesByIdSalaries200 = z.strictObject({
  items: z.array(
    z.strictObject({
      amounts: z.record(z.string(), z.number()).nullable(),
      annual_ctc: z.string().nullable(),
      approved_at: z.string().nullable(),
      created_at: z.string(),
      created_by_name: z.string(),
      effective_from: z.string(),
      id: z.string(),
      masked: z.boolean().optional(),
      maskedFields: z.array(z.string()).optional(),
      reason: z.string(),
      status: z.string(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetPayrollEmployeesByIdStatutory200 = z.strictObject({
  aadhaar: z.string().nullable(),
  esi_ip_number: z.string().nullable(),
  masked: z.boolean().optional(),
  maskedFields: z.array(z.string()).optional(),
  pan: z.string().nullable(),
  pf_excluded: z.boolean(),
  pf_member_id: z.string().nullable(),
  pt_state: z.string().nullable(),
  tax_regime: z.string(),
  uan: z.string().nullable(),
  updated_at: z.string().optional(),
});

export const GetPayrollFnfSuggestionsByEmployeeId200 = z.strictObject({
  kind: z.string(),
  lastWorkingDay: z.string(),
  leaveBalances: z.array(z.strictObject({ balance: z.string(), code: z.string(), name: z.string(), paid: z.boolean() })),
  leaveYear: z.number(),
  masked: z.boolean().optional(),
  maskedFields: z.array(z.string()).optional(),
  note: z.string(),
  noticeShortfallDays: z.number(),
  period: z.string(),
  salary: z.record(z.string(), z.number()).nullable(),
  shortfallWaived: z.boolean(),
  today: z.string(),
});

export const GetPayrollPayslipsById200 = z.strictObject({
  account: z.string().nullable(),
  branch: z.string(),
  brand: z.strictObject({
    currency: z.string(),
    dateFormat: z.string(),
    legalName: z.string(),
    locale: z.string(),
    logoUrl: z.string().nullable().optional(),
    name: z.string(),
    primaryColor: z.string(),
    productName: z.string(),
  }),
  date_of_joining: z.string(),
  days_in_period: z.string(),
  deductions: z.string().nullable(),
  department: z.string().nullable(),
  designation: z.string().nullable(),
  employed_days: z.string(),
  employee_code: z.string(),
  gross: z.string().nullable(),
  ifsc: z.string().nullable(),
  kind: z.string(),
  legal_entity: z.string(),
  lines: z.array(z.strictObject({ amount: z.number(), basis: z.string().optional(), code: z.string(), kind: z.string(), name: z.string() })).nullable(),
  lop_days: z.string(),
  masked: z.boolean().optional(),
  maskedFields: z.array(z.string()).optional(),
  name: z.string(),
  net: z.string().nullable(),
  paid_days: z.string(),
  pan: z.string().nullable(),
  period: z.string(),
  uan: z.string().nullable(),
});

export const GetPayrollPayslipsMine200 = z.strictObject({
  items: z.array(z.strictObject({ deductions: z.string(), gross: z.string(), id: z.string(), kind: z.string(), net: z.string(), period: z.string(), status: z.string() })),
});

export const GetPayrollRuns200 = z.strictObject({
  items: z.array(
    z.strictObject({
      computed_at: z.string().nullable(),
      created_by_name: z.string().nullable(),
      employee_name: z.string().nullable().optional(),
      excluded: z.number().optional(),
      finalized_at: z.string().nullable(),
      id: z.string(),
      kind: z.string(),
      legal_entity_name: z.string().nullable(),
      masked: z.boolean().optional(),
      maskedFields: z.array(z.string()).optional(),
      paid_at: z.string().nullable(),
      payment_reference: z.string().nullable().optional(),
      period: z.string(),
      released_count: z.number().nullable(),
      status: z.string(),
      totals: z
        .strictObject({
          deductions: z.number().nullable(),
          employees: z.number().nullable(),
          employerCost: z.number().nullable(),
          gross: z.number().nullable(),
          held: z.number().nullable(),
          net: z.number().nullable(),
        })
        .nullable(),
      warnings: z.number().nullable(),
      warnings_acknowledged: z.boolean().nullable(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetPayrollRunsById200 = z.strictObject({
  adjustments: z.array(
    z.strictObject({
      amount: z.string().nullable(),
      created_by_name: z.string().nullable(),
      employee_id: z.string(),
      id: z.string(),
      kind: z.string(),
      label: z.string().nullable(),
      note: z.string().nullable().optional(),
      taxable: z.boolean().nullable(),
    }),
  ),
  approved_at: z.string().nullable(),
  attendanceLocked: z.boolean().nullable(),
  computed_at: z.string().nullable(),
  computed_by: z.string().nullable(),
  created_at: z.string(),
  created_by: z.string().nullable(),
  employee_id: z.string().nullable(),
  excluded: z.number(),
  finalized_at: z.string().nullable(),
  id: z.string(),
  items: z.array(
    z.strictObject({
      deductions: z.string().nullable(),
      employed_days: z.string().nullable(),
      employee_code: z.string(),
      employee_id: z.string(),
      employee_name: z.string().nullable(),
      employer_cost: z.string().nullable(),
      gross: z.string().nullable(),
      hold: z.boolean().nullable(),
      hold_released_at: z.string().nullable().optional(),
      id: z.string(),
      lines: z.array(z.strictObject({ amount: z.number().nullable(), basis: z.string().optional(), code: z.string().nullable(), kind: z.string(), name: z.string() })).nullable(),
      lop_days: z.string().nullable(),
      masked: z.boolean().optional(),
      maskedFields: z.array(z.string()).optional(),
      net: z.string().nullable(),
      paid_days: z.string().nullable(),
      warnings: z.array(z.string()).nullable(),
    }),
  ),
  kind: z.string(),
  legal_entity_id: z.string(),
  legal_entity_name: z.string().nullable(),
  masked: z.boolean().optional(),
  maskedFields: z.array(z.string()).optional(),
  page: z.number(),
  pageSize: z.number(),
  paid_at: z.string().nullable(),
  payment_reference: z.string().nullable().optional(),
  period: z.string(),
  released_count: z.number().nullable(),
  status: z.string(),
  tenant_id: z.string().nullable(),
  total: z.number(),
  totals: z
    .strictObject({
      deductions: z.number().nullable(),
      employees: z.number().nullable(),
      employerCost: z.number().nullable(),
      gross: z.number().nullable(),
      held: z.number().nullable(),
      net: z.number().nullable(),
    })
    .nullable(),
  warnings: z.number().nullable(),
  warnings_acknowledged: z.boolean().nullable(),
});

export const GetPayrollStatutoryRules200 = z.strictObject({
  items: z.array(
    z.strictObject({
      created_at: z.string(),
      created_by: z.string(),
      created_by_name: z.string(),
      effective_from: z.string(),
      effective_to: z.string().nullable(),
      id: z.string(),
      kind: z.string(),
      params: z.looseObject({ slabs: z.array(z.looseObject({ amount: z.number(), upTo: z.unknown() })) }),
      scope: z.string(),
      source_reference: z.string(),
      status: z.string(),
      verified_at: z.string().nullable(),
      verified_by_name: z.string().nullable(),
    }),
  ),
});

export const GetPerformanceCycles200 = z.strictObject({
  items: z.array(
    z.strictObject({
      finalized: z.number(),
      id: z.string(),
      name: z.string(),
      period_end: z.string(),
      period_start: z.string(),
      reviews: z.number(),
      self_review: z.boolean(),
      status: z.string(),
    }),
  ),
});

export const GetPerformanceCyclesByIdGoalsByEmployeeId200 = z.strictObject({
  items: z.array(
    z.strictObject({
      description: z.string().nullable(),
      id: z.string(),
      measure: z.string().nullable(),
      progress: z.number(),
      status: z.string(),
      title: z.string(),
      weight: z.number(),
    }),
  ),
  totalWeight: z.number(),
});

export const GetPerformanceReviews200 = z.strictObject({
  items: z.array(
    z.strictObject({
      designation: z.string().nullable(),
      employee_code: z.string(),
      employee_id: z.string(),
      employee_name: z.string(),
      final_rating: z.number().nullable(),
      id: z.string(),
      manager_rating: z.number().nullable(),
      reviewer_name: z.string().nullable(),
      self_rating: z.number().nullable(),
      status: z.string(),
    }),
  ),
});

export const GetPerformanceReviewsById200 = z.strictObject({
  cycle_id: z.string(),
  cycle_name: z.string(),
  employee_ack_at: z.string().nullable(),
  employee_ack_note: z.string().nullable(),
  employee_id: z.string(),
  employee_name: z.string(),
  final_comments: z.string().nullable(),
  final_rating: z.number().nullable(),
  finalized_by: z.string().nullable(),
  goal_ratings: z.record(z.string(), z.unknown()),
  goals: z.array(z.strictObject({ id: z.string(), measure: z.string().nullable(), progress: z.number(), status: z.string(), title: z.string(), weight: z.number() })),
  id: z.string(),
  manager_comments: z.string().nullable(),
  manager_rating: z.number().nullable(),
  period_end: z.string(),
  period_start: z.string(),
  reviewer_id: z.string().nullable(),
  role: z.string(),
  self_comments: z.string().nullable(),
  self_rating: z.number().nullable(),
  status: z.string(),
  tenant_id: z.string(),
  version: z.number(),
});

export const GetPolicies200 = z.strictObject({
  items: z.array(
    z.strictObject({
      acknowledged: z.number(),
      audience: z.number(),
      category: z.string(),
      code: z.string(),
      created_at: z.string(),
      drafts: z.number(),
      effective_from: z.string(),
      id: z.string(),
      owner: z.string().nullable(),
      published_at: z.string().nullable(),
      published_version: z.number(),
      published_version_id: z.string(),
      requires_ack: z.boolean(),
      status: z.string(),
      title: z.string(),
    }),
  ),
});

export const GetPoliciesById200 = z.strictObject({
  category: z.string(),
  code: z.string(),
  created_at: z.string(),
  id: z.string(),
  owner: z.string().nullable(),
  status: z.string(),
  title: z.string(),
  versions: z.array(
    z.strictObject({
      ack_due_days: z.number(),
      acknowledgements: z.number(),
      audience_branch_ids: z.array(z.string()),
      audience_department_ids: z.array(z.string()),
      change_summary: z.string(),
      created_at: z.string(),
      created_by: z.string(),
      created_by_name: z.string(),
      effective_from: z.string(),
      file_name: z.string().nullable(),
      has_body: z.boolean(),
      id: z.string(),
      published_at: z.string().nullable(),
      published_by_name: z.string().nullable(),
      requires_ack: z.boolean(),
      status: z.string(),
      version_no: z.number(),
    }),
  ),
});

export const GetPoliciesMine200 = z.strictObject({
  date: z.string().optional(),
  items: z.array(
    z.strictObject({
      acknowledged_at: z.string().nullable(),
      category: z.string(),
      change_summary: z.string(),
      code: z.string(),
      due_on: z.string(),
      effective_from: z.string(),
      id: z.string(),
      published_at: z.string().nullable(),
      requires_ack: z.boolean(),
      title: z.string(),
      version_no: z.number(),
    }),
  ),
  overdue: z.number().optional(),
  pending: z.number(),
});

export const GetPoliciesVersionsById200 = z.strictObject({
  acknowledgedAt: z.string().nullable(),
  body: z.string().nullable(),
  changeSummary: z.string(),
  code: z.string(),
  contentSha256: z.string(),
  effectiveFrom: z.string(),
  fileName: z.string().nullable(),
  hasFile: z.boolean(),
  id: z.string(),
  policyId: z.string(),
  publishedAt: z.string().nullable(),
  requiresAck: z.boolean(),
  status: z.string(),
  title: z.string(),
  versionNo: z.number(),
});

export const GetPoliciesVersionsByIdAcknowledgements200 = z.strictObject({
  items: z.array(
    z.strictObject({
      acknowledged_at: z.string().nullable(),
      branch: z.string(),
      content_sha256: z.string().nullable(),
      department: z.string(),
      employee_code: z.string(),
      employee_id: z.string(),
      name: z.string(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetRecruitmentApplicationsById200 = z.strictObject({
  access: z.string(),
  allowedMoves: z.array(z.string()),
  candidate: z.strictObject({
    current_company: z.string().nullable(),
    current_designation: z.string().nullable(),
    email: z.string().nullable(),
    experience_months: z.number().nullable(),
    first_name: z.string(),
    has_resume: z.boolean(),
    id: z.string(),
    last_name: z.string().nullable(),
    location: z.string().nullable(),
    notice_days: z.number().nullable(),
    phone: z.string().nullable(),
    qualification: z.string().nullable(),
    status: z.string(),
  }),
  events: z.array(z.strictObject({ actor_name: z.string(), at: z.string(), from_stage: z.string().nullable(), note: z.string().nullable(), to_stage: z.string() })),
  id: z.string(),
  interviews: z.array(
    z.strictObject({
      duration_min: z.number(),
      id: z.string(),
      kind: z.string(),
      location: z.string().nullable(),
      panel: z.array(
        z.strictObject({
          hidden: z.boolean().optional(),
          name: z.string(),
          notes: z.string().nullable(),
          rating: z.number().nullable(),
          recommendation: z.string().nullable(),
          submitted_at: z.string().nullable(),
          user_id: z.string(),
        }),
      ),
      round: z.number(),
      scheduled_at: z.string(),
      status: z.string(),
    }),
  ),
  offers: z.array(
    z.strictObject({
      above_budget: z.boolean(),
      annual_ctc: z.string().nullable(),
      approved_at: z.string().nullable(),
      branch_name: z.string(),
      created_at: z.string(),
      designation: z.string(),
      employee_id: z.string().nullable(),
      employment_type: z.string(),
      id: z.string(),
      joining_date: z.string(),
      masked: z.boolean().optional(),
      maskedFields: z.array(z.string()).optional(),
      notes: z.string().nullable(),
      probation_months: z.number().nullable(),
      responded_at: z.string().nullable(),
      sent_at: z.string().nullable(),
      status: z.string(),
    }),
  ),
  requisition: z.strictObject({ code: z.string(), id: z.string(), status: z.string(), title: z.string() }),
  stage: z.string(),
  version: z.number(),
});

export const GetRecruitmentCandidates200 = z.strictObject({
  items: z.array(
    z.strictObject({
      applications: z.number(),
      created_at: z.string(),
      current_company: z.string().nullable(),
      current_designation: z.string().nullable(),
      email: z.string().nullable(),
      employee_id: z.string().nullable(),
      experience_months: z.number().nullable(),
      first_name: z.string(),
      has_resume: z.boolean(),
      id: z.string(),
      last_name: z.string().nullable(),
      location: z.string().nullable(),
      phone: z.string().nullable(),
      qualification: z.string().nullable(),
      retain_until: z.string(),
      source: z.string(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetRecruitmentCandidatesById200 = z.strictObject({
  applications: z.array(
    z.strictObject({ id: z.string(), number: z.number(), requisition_code: z.string(), requisition_id: z.string(), stage: z.string(), title: z.string(), updated_at: z.string() }),
  ),
  consent_at: z.string(),
  consent_note: z.string(),
  created_at: z.string(),
  current_company: z.string().nullable(),
  current_designation: z.string().nullable(),
  email: z.string().nullable(),
  employee_id: z.string().nullable(),
  expected_ctc: z.string().nullable(),
  experience_months: z.number().nullable(),
  first_name: z.string(),
  has_resume: z.boolean(),
  id: z.string(),
  last_name: z.string().nullable(),
  location: z.string().nullable(),
  masked: z.boolean().optional(),
  maskedFields: z.array(z.string()).optional(),
  notice_days: z.number().nullable(),
  phone: z.string().nullable(),
  qualification: z.string().nullable(),
  referred_by_name: z.string().nullable(),
  resume_name: z.string().nullable(),
  retain_until: z.string(),
  source: z.string(),
  status: z.string(),
});

export const GetRecruitmentInterviewsMine200 = z.strictObject({
  items: z.array(
    z.strictObject({
      application_id: z.string(),
      duration_min: z.number(),
      first_name: z.string(),
      id: z.string(),
      kind: z.string(),
      last_name: z.string().nullable(),
      location: z.string().nullable(),
      number: z.number(),
      requisition_code: z.string(),
      requisition_title: z.string(),
      round: z.number(),
      scheduled_at: z.string(),
      status: z.string(),
      submitted_at: z.string().nullable(),
    }),
  ),
});

export const GetRecruitmentPanelUsers200 = z.strictObject({ items: z.array(z.strictObject({ designation: z.string().nullable(), display_name: z.string(), id: z.string() })) });

export const GetRecruitmentRequisitions200 = z.strictObject({
  items: z.array(
    z.strictObject({
      branch_name: z.string(),
      budget_ctc_max: z.string().nullable(),
      code: z.string(),
      created_at: z.string(),
      department_name: z.string().nullable(),
      designation: z.string().nullable(),
      employment_type: z.string(),
      filled: z.number(),
      hiring_manager_name: z.string().nullable(),
      id: z.string(),
      masked: z.boolean().optional(),
      maskedFields: z.array(z.string()).optional(),
      number: z.number(),
      pipeline: z
        .strictObject({
          applied: z.number().optional(),
          interview: z.number().optional(),
          offer: z.number().optional(),
          rejected: z.number().optional(),
          screening: z.number().optional(),
        })
        .nullable(),
      positions: z.number(),
      status: z.string(),
      target_date: z.string().nullable(),
      title: z.string(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetRecruitmentRequisitionsById200 = z.strictObject({
  applications: z.array(
    z.strictObject({
      avg_rating: z.string().nullable(),
      candidate_id: z.string(),
      candidate_status: z.string(),
      current_company: z.string().nullable(),
      experience_months: z.number().nullable(),
      first_name: z.string(),
      id: z.string(),
      last_name: z.string().nullable(),
      rejection_reason: z.string().nullable(),
      source: z.string(),
      stage: z.string(),
      updated_at: z.string(),
    }),
  ),
  approved_at: z.string().nullable(),
  branch_id: z.string(),
  branch_name: z.string(),
  budget_ctc_max: z.string().nullable(),
  closed_at: z.string().nullable(),
  code: z.string(),
  created_at: z.string(),
  created_by: z.string(),
  created_by_name: z.string(),
  department_id: z.string().nullable(),
  department_name: z.string().nullable(),
  designation: z.string().nullable(),
  employment_type: z.string(),
  filled: z.number(),
  hiring_manager_id: z.string().nullable(),
  hiring_manager_name: z.string().nullable(),
  id: z.string(),
  justification: z.string(),
  legal_entity_id: z.string(),
  legal_entity_name: z.string(),
  masked: z.boolean().optional(),
  maskedFields: z.array(z.string()).optional(),
  number: z.number(),
  positions: z.number(),
  status: z.string(),
  target_date: z.string().nullable(),
  tenant_id: z.string(),
  title: z.string(),
  version: z.number(),
});

export const GetReports200 = z.strictObject({
  advanced: z.boolean(),
  items: z.array(
    z.strictObject({
      category: z.string(),
      description: z.string(),
      key: z.string(),
      name: z.string(),
      params: z.array(
        z.strictObject({
          default: z.union([z.string(), z.number()]),
          key: z.string(),
          label: z.string(),
          max: z.number().optional(),
          min: z.number().optional(),
          options: z.array(z.strictObject({ label: z.string(), value: z.string() })).optional(),
          type: z.string(),
        }),
      ),
      scope: z.string(),
    }),
  ),
  today: z.string(),
});

export const GetReportsByKey200 = z.strictObject({
  columns: z.array(z.strictObject({ key: z.string(), label: z.string(), type: z.string() })),
  excluded: z.number().optional(),
  generatedAt: z.string(),
  key: z.string(),
  name: z.string(),
  notes: z.array(z.string()),
  params: z.strictObject({
    asOf: z.string().optional(),
    event: z.string().optional(),
    from: z.string().optional(),
    groupBy: z.string().optional(),
    show: z.string().optional(),
    status: z.string().optional(),
    to: z.string().optional(),
    withinDays: z.number().optional(),
    year: z.number().optional(),
  }),
  rows: z.array(z.record(z.string(), z.unknown())),
  scope: z.string(),
  today: z.string(),
  totals: z.record(z.string(), z.unknown()).nullable(),
  truncated: z.boolean(),
});

export const GetReportsSaved200 = z.strictObject({
  items: z.array(
    z.strictObject({
      created_at: z.string(),
      id: z.string(),
      name: z.string(),
      params: z.looseObject({ groupBy: z.string().optional() }),
      reportName: z.string(),
      report_key: z.string(),
      schedule: z
        .looseObject({
          dayOfMonth: z.unknown(),
          enabled: z.boolean(),
          frequency: z.string(),
          id: z.string(),
          lastResult: z.unknown(),
          lastRunAt: z.unknown(),
          nextRunOn: z.string(),
          period: z.string(),
          recipientIds: z.array(z.string()),
          weekday: z.unknown(),
        })
        .nullable(),
    }),
  ),
});

export const GetReportsSavedByIdRecipients200 = z.strictObject({ items: z.array(z.strictObject({ email: z.string(), id: z.string(), name: z.string() })) });

export const GetReportsSnapshots200 = z.strictObject({
  items: z.array(
    z.strictObject({
      expires_at: z.string(),
      generated_at: z.string(),
      id: z.string(),
      name: z.string(),
      owner: z.string(),
      params: z.looseObject({ asOf: z.string().optional(), from: z.string().optional(), groupBy: z.string().optional(), to: z.string().optional() }),
      report_key: z.string(),
      row_count: z.number(),
      scope: z.string(),
    }),
  ),
});

export const GetReportsSnapshotsById200 = z.strictObject({
  columns: z.array(z.looseObject({ key: z.string(), label: z.string(), type: z.string() })),
  generatedAt: z.string(),
  id: z.string(),
  key: z.string(),
  name: z.string(),
  notes: z.array(z.string()),
  params: z.looseObject({ asOf: z.string().optional(), from: z.string().optional(), groupBy: z.string().optional(), to: z.string().optional() }),
  rows: z.array(z.record(z.string(), z.union([z.number(), z.string()]))),
  scope: z.string(),
  totals: z.record(z.string(), z.union([z.number(), z.string()]).nullable()).nullable(),
});

export const GetTenantAudit200 = z.strictObject({
  items: z.array(
    z.strictObject({
      action: z.string(),
      actor_name: z.string().nullable(),
      actor_type: z.string(),
      category: z.string(),
      change_metadata: z.record(z.string(), z.unknown()),
      created_at: z.string(),
      id: z.string(),
      ip: z.string().nullable(),
      setting_key: z.string().nullable(),
      target_id: z.string().nullable(),
      target_type: z.string().nullable(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetTenantAuditChain200 = z.strictObject({
  items: z.array(
    z.strictObject({
      action: z.string(),
      actor_id: z.string().nullable(),
      actor_type: z.string(),
      category: z.string(),
      chain_seq: z.string().nullable(),
      change_metadata: z.record(z.string(), z.unknown()),
      created_at: z.string(),
      id: z.string(),
      ip: z.string().nullable(),
      prev_hash: z.string().nullable(),
      row_hash: z.string().nullable(),
      target_id: z.string().nullable(),
      target_type: z.string().nullable(),
      user_agent: z.string().nullable(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetTenantAuditChainVerify200 = z.strictObject({ brokenAt: z.number().nullable(), checked: z.number(), ok: z.boolean(), reason: z.string().nullable() });

export const GetTenantCompany200 = z.strictObject({
  bankAccountHolder: z.string().nullable().optional(),
  bankAccountMasked: z.string().nullable().optional(),
  bankAccountNumber: z.string().optional(),
  bankIfsc: z.string().nullable().optional(),
  bankName: z.string().nullable().optional(),
  cin: z.string().nullable(),
  editable: z.boolean(),
  esiRegistration: z.string().nullable().optional(),
  gstin: z.string().nullable(),
  hasSignature: z.boolean(),
  hasStamp: z.boolean(),
  legalName: z.string().nullable(),
  masked: z.boolean().optional(),
  maskedFields: z.array(z.string()).optional(),
  panMasked: z.string().nullable(),
  pfRegistration: z.string().nullable().optional(),
  ptRegistration: z.string().nullable().optional(),
  registeredAddress: z.string().nullable(),
  signatoryDesignation: z.string().nullable(),
  signatoryName: z.string().nullable(),
  stored: z.strictObject({ cin: z.string().nullable(), gstin: z.string().nullable(), legalName: z.string().nullable() }),
  tan: z.string().nullable(),
  updatedAt: z.string().nullable(),
  version: z.number(),
});

export const GetTenantDataRightsCandidatesByIdExport200 = z.strictObject({
  applications: z.array(z.strictObject({ created_at: z.string(), id: z.string(), rejection_reason: z.string().nullable(), stage: z.string(), title: z.string() })),
  candidate: z.strictObject({
    consent_at: z.string(),
    consent_note: z.string(),
    created_at: z.string(),
    current_company: z.string().nullable(),
    current_designation: z.string().nullable(),
    email: z.string().nullable(),
    expected_ctc: z.string().nullable().optional(),
    experience_months: z.number().nullable(),
    first_name: z.string(),
    id: z.string(),
    last_name: z.string().nullable(),
    location: z.string().nullable(),
    notice_days: z.number().nullable(),
    phone: z.string().nullable(),
    qualification: z.string().nullable(),
    resume_name: z.string().nullable(),
    retain_until: z.string(),
    source: z.string(),
    status: z.string(),
  }),
  complete: z.boolean(),
  generatedAt: z.string(),
  subject: z.strictObject({ id: z.string(), type: z.string() }),
});

export const GetTenantDataRightsEmployeesByIdExport200 = z.strictObject({
  complete: z.boolean(),
  generatedAt: z.string(),
  l4Included: z.boolean(),
  note: z.string(),
  sections: z.array(
    z.strictObject({
      key: z.string(),
      maskedColumns: z.array(z.string()).optional(),
      nextOffset: z.number().nullable(),
      rows: z.array(z.record(z.string(), z.unknown())),
      total: z.number(),
      withheld: z.boolean().optional(),
    }),
  ),
  subject: z.strictObject({ id: z.string(), type: z.string() }),
});

export const GetTenantDataRightsErasureRequests200 = z.strictObject({
  items: z.array(
    z.strictObject({
      completedAt: z.string().nullable(),
      createdAt: z.string(),
      decidedAt: z.string().nullable(),
      decidedBy: z.string().nullable(),
      decisionNote: z.string().nullable(),
      id: z.string(),
      reason: z.string().nullable(),
      report: z.record(z.string(), z.unknown()).nullable(),
      requestedBy: z.string(),
      retainedUntil: z.string().nullable(),
      status: z.string(),
      subjectId: z.string(),
      subjectType: z.string(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetTenantDataRightsErasureRequestsById200 = z.strictObject({
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decisionNote: z.string().nullable(),
  id: z.string(),
  reason: z.string().nullable(),
  report: z.record(z.string(), z.unknown()).nullable(),
  requestedBy: z.string(),
  retainedUntil: z.string().nullable(),
  status: z.string(),
  subjectId: z.string(),
  subjectType: z.string(),
});

export const GetTenantDataRightsRetention200 = z.strictObject({
  auditLog: z.string(),
  carveOuts: z.array(z.strictObject({ basis: z.string(), category: z.string(), label: z.string(), setting: z.string(), years: z.number() })),
  notLegalAdvice: z.string(),
});

export const GetTenantInstallation200 = z.strictObject({
  auth: z.strictObject({ resetByEmail: z.boolean() }),
  brand: z.strictObject({
    accentColor: z.string().nullable(),
    country: z.string(),
    currency: z.string(),
    dateFormat: z.string(),
    domain: z.string(),
    faviconUrl: z.string().nullable(),
    financialYearStart: z.string(),
    fontFamily: z.string().nullable(),
    helpUrl: z.string().nullable(),
    legalName: z.string(),
    locale: z.string(),
    loginMessage: z.string().nullable(),
    logoDarkUrl: z.string().nullable(),
    logoUrl: z.string().nullable(),
    name: z.string(),
    primaryColor: z.string(),
    secondaryColor: z.string().nullable(),
    supportEmail: z.string(),
    supportPhone: z.string().nullable(),
    timezone: z.string(),
  }),
  domains: z.array(z.strictObject({ activation_status: z.string(), hostname: z.string(), is_primary: z.boolean() })),
  features: z.record(z.string(), z.boolean()),
  managedBy: z.string(),
  mfa: z.strictObject({ available: z.boolean(), enforced: z.boolean(), methods: z.array(z.string()) }),
  mode: z.string(),
  modules: z.array(
    z.strictObject({
      availability: z.string(),
      blockers: z.array(z.string()),
      category: z.string(),
      configured: z.boolean(),
      core: z.boolean(),
      dependencies: z.array(z.string()),
      dependenciesMet: z.boolean(),
      dependents: z.array(z.string()),
      description: z.string(),
      enabled: z.boolean(),
      key: z.string(),
      name: z.string(),
      operational: z.string(),
      supported: z.boolean(),
      usable: z.boolean(),
    }),
  ),
  product: z.strictObject({ name: z.string() }),
});

export const GetTenantJobs200 = z.strictObject({
  items: z.array(
    z.strictObject({
      active: z.boolean(),
      canRun: z.boolean(),
      description: z.string(),
      feature: z.union([z.string(), z.array(z.string())]).nullable(),
      key: z.string(),
      name: z.string(),
      nextRun: z.string(),
      recentRuns: z.array(
        z.strictObject({
          attempts: z.number(),
          error: z.string().nullable(),
          finished_at: z.string().nullable(),
          id: z.string(),
          job_key: z.string(),
          next_retry_at: z.string().nullable(),
          period_key: z.string(),
          result: z.looseObject({
            alreadyCredited: z.number(),
            credited: z.number(),
            durationMs: z.number(),
            employees: z.number(),
            leaveYear: z.number(),
            throughMonth: z.number(),
            types: z.number(),
          }),
          started_at: z.string(),
          status: z.string(),
          trigger: z.string(),
          triggered_by_name: z.string(),
        }),
      ),
      schedule: z.strictObject({ at: z.string(), day: z.number().optional(), kind: z.string() }),
    }),
  ),
  maxAttempts: z.number(),
  runsPage: z.strictObject({ page: z.number(), pageSize: z.number(), total: z.number() }),
  timezone: z.string(),
});

export const GetTenantRoles200 = z.strictObject({
  canManage: z.boolean(),
  custom: z.array(
    z.strictObject({
      description: z.string().nullable(),
      grantable: z.boolean(),
      key: z.string(),
      name: z.string(),
      permissions: z.array(z.string()),
      updated_at: z.string(),
      updated_by_name: z.string().nullable(),
      users: z.number(),
    }),
  ),
  maxPermissions: z.array(z.string()).nullable(),
  permissions: z.array(z.strictObject({ key: z.string(), label: z.string() })),
  system: z.array(z.strictObject({ grantable: z.boolean(), group: z.string(), key: z.string(), name: z.string(), permissions: z.array(z.string()), users: z.number() })),
});

export const GetTenantSettings200 = z.strictObject({
  items: z.array(
    z.strictObject({
      branchValue: z.array(z.number()).nullable(),
      control: z.string(),
      defaultValue: z.union([z.string(), z.array(z.number()), z.number(), z.boolean()]).nullable(),
      description: z.string(),
      editPermission: z.string(),
      editable: z.boolean(),
      effective: z.union([z.string(), z.array(z.number()), z.number(), z.boolean()]).nullable(),
      feature: z.union([z.string(), z.array(z.string())]).nullable(),
      group: z.string(),
      key: z.string(),
      label: z.string(),
      options: z.array(z.strictObject({ label: z.string(), value: z.string() })).nullable(),
      platformValue: z.unknown(),
      scopes: z.array(z.string()),
      source: z.string(),
      tenantValue: z.union([z.number(), z.boolean(), z.string(), z.array(z.number())]).nullable(),
      version: z.number().nullable(),
    }),
  ),
});

export const GetTenantUsers200 = z.strictObject({
  items: z.array(
    z.strictObject({
      display_name: z.string(),
      effective_salary_level: z.number(),
      email: z.string(),
      employee_code: z.string().nullable(),
      employee_id: z.string().nullable(),
      id: z.string(),
      invite_pending: z.boolean(),
      last_login_at: z.string().nullable(),
      locked: z.boolean(),
      mfa_enabled: z.boolean(),
      roles: z.array(z.string()),
      salary_access_level: z.number(),
      status: z.string(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetTravelRequests200 = z.strictObject({
  items: z.array(z.record(z.string(), z.union([z.boolean(), z.string()]).nullable())),
  page: z.number(),
  pageSize: z.number(),
  today: z.string(),
  total: z.number(),
});

export const GetTravelRequestsById200 = z.looseObject({
  accommodation: z.boolean(),
  advance_paid_amount: z.string().nullable(),
  advance_paid_at: z.string().nullable(),
  advance_reference: z.string().nullable(),
  advance_requested: z.string(),
  approval_request_id: z.string().nullable(),
  cancel_reason: z.string().nullable(),
  closed_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  created_at: z.string(),
  decided_at: z.string().nullable(),
  department: z.string(),
  destination: z.string(),
  employee_code: z.string(),
  employee_id: z.string(),
  end_date: z.string(),
  estimate_local: z.string(),
  estimate_meals: z.string(),
  estimate_other: z.string(),
  estimate_stay: z.string(),
  estimate_total: z.string().nullable(),
  estimate_travel: z.string(),
  field_duty_id: z.string().nullable(),
  id: z.string(),
  mark_on_duty: z.boolean(),
  name: z.string(),
  on_duty_note: z.string().nullable(),
  origin: z.string(),
  project: z.string().nullable(),
  purpose: z.string(),
  recovered_amount: z.string(),
  recovered_note: z.string().nullable(),
  settlement: z.looseObject({
    advanceAdjusted: z.string(),
    advancePaid: z.string(),
    claimed: z.string(),
    claims: z.array(z.looseObject({ advance_adjusted: z.string(), id: z.string(), paid_at: z.string().nullable(), status: z.string(), title: z.string(), total: z.string() })),
    openClaims: z.number(),
    outstanding: z.string(),
    recovered: z.string(),
    reimbursable: z.string(),
  }),
  start_date: z.string(),
  status: z.string(),
  travel_mode: z.string(),
  trip_type: z.string(),
});

export const PatchAttendanceDevicesById200 = z.strictObject({ ok: z.boolean() });

export const PatchAttendanceRosterPatternsById200 = z.strictObject({ ok: z.boolean() });

export const PatchEmployeesById200 = z.strictObject({ changed: z.array(z.string()), ok: z.boolean(), version: z.number() });

export const PatchTenantRolesByKey200 = z.strictObject({ holdersSignedOut: z.number(), ok: z.boolean() });

export const PatchTenantUsersById200 = z.strictObject({ ok: z.boolean() });

export const PostApprovalsByIdAct200 = z.strictObject({ status: z.string() });

export const PostApprovalsByIdCancel200 = z.strictObject({ ok: z.boolean() });

export const PostApprovalsByIdReassign200 = z.strictObject({ ok: z.boolean() });

export const PostApprovalsDelegations201 = z.strictObject({ id: z.string() });

export const PostApprovalsDelegationsByIdRevoke200 = z.strictObject({ ok: z.boolean() });

export const PostAssets201 = z.strictObject({ id: z.string() });

export const PostAssetsAssignmentsByIdAcknowledge200 = z.strictObject({ ok: z.boolean() });

export const PostAssetsByIdIssue200 = z.strictObject({ ok: z.boolean() });

export const PostAssetsByIdReceive200 = z.strictObject({ ok: z.boolean() });

export const PostAttendanceDevices201 = z.strictObject({ apiKey: z.string(), id: z.string() });

export const PostAttendanceDevicesByIdRotateKey200 = z.strictObject({ apiKey: z.string() });

export const PostAttendanceHolidays201 = z.strictObject({ id: z.string() });

export const PostAttendanceLocks201 = z.strictObject({ id: z.string(), rowsLocked: z.number() });

export const PostAttendancePunch200 = z.strictObject({
  direction: z.string().optional(),
  duplicate: z.boolean(),
  eventTime: z.string().optional(),
  id: z.string().optional(),
  outsideGeofence: z.boolean().optional(),
});

export const PostAttendanceRecalculate200 = z.strictObject({ daysCalculated: z.number(), employees: z.number(), lockedDaysSkipped: z.number() });

export const PostAttendanceRegularizations201 = z.strictObject({ approvalRequestId: z.string(), id: z.string() });

export const PostAttendanceRosterAssignments200 = z.strictObject({ assigned: z.number(), recalculated: z.number() });

export const PostAttendanceRosterAssignmentsEnd200 = z.strictObject({ ended: z.number() });

export const PostAttendanceRosterPatterns201 = z.strictObject({ id: z.string() });

export const PostAttendanceSelfies201 = z.strictObject({ id: z.string() });

export const PostAttendanceShiftAssignments200 = z.strictObject({ assigned: z.number() });

export const PostAttendanceShifts201 = z.strictObject({ id: z.string() });

export const PostAuthLogin200 = z.strictObject({
  csrfToken: z.string(),
  expiresAt: z.string(),
  mfaDelivery: z.string().nullable(),
  mfaMethod: z.string().nullable(),
  mfaRequired: z.boolean(),
  passwordChangeRequired: z.boolean(),
});

export const PostAuthLogout200 = z.strictObject({ ok: z.boolean() });

export const PostAuthMfaDisable200 = z.strictObject({ csrfToken: z.string(), ok: z.boolean() });

export const PostAuthMfaEmailEnable200 = z.strictObject({ csrfToken: z.string(), recoveryCodes: z.array(z.string()) });

export const PostAuthMfaEmailSend200 = z.strictObject({ sent: z.boolean() });

export const PostAuthMfaEmailSetup200 = z.strictObject({ sent: z.boolean() });

export const PostAuthMfaEnable200 = z.strictObject({ csrfToken: z.string(), recoveryCodes: z.array(z.string()) });

export const PostAuthMfaRecoveryCodes200 = z.strictObject({ recoveryCodes: z.array(z.string()) });

export const PostAuthMfaSetup200 = z.strictObject({ otpauthUri: z.string(), secret: z.string() });

export const PostAuthMfaVerify200 = z.strictObject({ csrfToken: z.string(), method: z.string(), ok: z.boolean() });

export const PostAuthPassword200 = z.strictObject({ csrfToken: z.string(), ok: z.boolean() });

export const PostAuthPasswordForgot200 = z.strictObject({ ok: z.boolean() });

export const PostAuthPasswordReset200 = z.strictObject({ ok: z.boolean() });

export const PostAuthSessionsRevokeAll200 = z.strictObject({ ok: z.boolean() });

export const PostAuthSetup200 = z.strictObject({ ok: z.boolean() });

export const PostCases201 = z.strictObject({ id: z.string(), reference: z.string() });

export const PostCasesByIdAssign200 = z.strictObject({ ok: z.boolean() });

export const PostCasesByIdEvents201 = z.strictObject({ ok: z.boolean() });

export const PostCasesByIdWithdraw200 = z.strictObject({ ok: z.boolean() });

export const PostCompetencyAssessments201 = z.strictObject({ id: z.string() });

export const PostCompetencyAuthorizations201 = z.strictObject({ approvalRequestId: z.string(), id: z.string() });

export const PostCompetencyAuthorizationsByIdCancel200 = z.strictObject({ ok: z.boolean() });

export const PostCompetencyAuthorizationsByIdReinstate200 = z.strictObject({ ok: z.boolean(), status: z.string() });

export const PostCompetencyAuthorizationsByIdSuspend200 = z.strictObject({ ok: z.boolean(), status: z.string() });

export const PostCompetencyAuthorizationsByIdWithdraw200 = z.strictObject({ ok: z.boolean(), status: z.string() });

export const PostCompetencyCourses201 = z.strictObject({ id: z.string() });

export const PostCompetencyMethods201 = z.strictObject({ id: z.string() });

export const PostCompetencyTrainingRecords201 = z.strictObject({ expiresOn: z.string().nullable(), id: z.string() });

export const PostCompetencyTrainingRecordsByIdRevoke200 = z.strictObject({ ok: z.boolean() });

export const PostDevicesEvents200 = z.strictObject({
  accepted: z.number(),
  clockDriftSeconds: z.number(),
  duplicates: z.number(),
  rejected: z.number(),
  unmapped: z.number(),
  warning: z.string().nullable(),
});

export const PostDocuments201 = z.strictObject({ id: z.string() });

export const PostDocumentsByIdArchive200 = z.strictObject({ ok: z.boolean() });

export const PostDocumentsCategories201 = z.strictObject({ id: z.string() });

export const PostEmployees201 = z.strictObject({ id: z.string() });

export const PostEmployeesImport200 = z.strictObject({
  committed: z.boolean(),
  report: z.array(z.strictObject({ employeeCode: z.string(), errors: z.array(z.string()), row: z.number(), warnings: z.array(z.string()) })),
  summary: z.strictObject({ errors: z.number(), total: z.number(), valid: z.number(), warnings: z.number() }),
});

export const PostEmployeesProfileChangesByChangeIdWithdraw200 = z.strictObject({ ok: z.boolean() });

export const PostExpensesAllowanceRates201 = z.strictObject({ id: z.string() });

export const PostExpensesBatches201 = z.strictObject({ id: z.string(), total: z.string() });

export const PostExpensesBatchesByIdApprove200 = z.strictObject({ ok: z.boolean() });

export const PostExpensesBatchesByIdCancel200 = z.strictObject({ ok: z.boolean() });

export const PostExpensesBatchesByIdPaid200 = z.strictObject({ claimsPaid: z.number(), ok: z.boolean() });

export const PostExpensesCategories201 = z.strictObject({ id: z.string() });

export const PostExpensesClaims201 = z.strictObject({ id: z.string() });

export const PostExpensesClaimsByIdCancel200 = z.strictObject({ ok: z.boolean() });

export const PostExpensesClaimsByIdItems201 = z.strictObject({
  allowance: z.string().optional(),
  amount: z.string().optional(),
  id: z.string(),
  possibleDuplicate: z.boolean(),
  rate: z.string().optional(),
});

export const PostExpensesClaimsByIdSubmit200 = z.strictObject({ approvalRequestId: z.string(), ok: z.boolean() });

export const PostFieldDutyRequests201 = z.strictObject({ id: z.string() });

export const PostFieldDutyRequestsByIdCancel200 = z.strictObject({ ok: z.boolean() });

export const PostFieldDutyRequestsByIdReport200 = z.strictObject({ ok: z.boolean() });

export const PostFieldDutyRequestsByIdWithdraw200 = z.strictObject({ ok: z.boolean() });

export const PostLeaveAccruals200 = z.strictObject({
  alreadyCredited: z.number(),
  credited: z.number(),
  employees: z.number(),
  leaveYear: z.number(),
  throughMonth: z.number(),
  types: z.number(),
});

export const PostLeaveAdjustments201 = z.strictObject({ ok: z.boolean() });

export const PostLeaveRequests201 = z.strictObject({ approvalRequestId: z.string(), days: z.string(), id: z.string() });

export const PostLeaveRequestsByIdCancel200 = z.strictObject({ ok: z.boolean(), reversedDays: z.string() });

export const PostLeaveRequestsPreview200 = z.strictObject({
  available: z.string(),
  days: z.string(),
  leaveYear: z.number(),
  paid: z.boolean(),
  perDate: z.array(z.strictObject({ date: z.string(), fraction: z.number() })),
  requiresBalance: z.boolean(),
  sufficient: z.boolean(),
});

export const PostLeaveTypes201 = z.strictObject({ id: z.string() });

export const PostLeaveYearEnd200 = z.strictObject({
  balancesProcessed: z.number(),
  daysCarried: z.string(),
  daysLapsed: z.string(),
  leaveYear: z.number(),
  overspent: z.number(),
  repaired: z.number(),
});

export const PostLifecycleChecklists201 = z.strictObject({ id: z.string() });

export const PostLifecycleChecklistsByIdCancel200 = z.strictObject({ ok: z.boolean() });

export const PostLifecycleEmployeesByIdJoined200 = z.strictObject({ ok: z.boolean() });

export const PostLifecycleProbationByIdSubmit200 = z.strictObject({ ok: z.boolean() });

export const PostLifecycleSeparations201 = z.strictObject({ id: z.string(), noticeDaysRequired: z.number(), shortfallDays: z.number() });

export const PostLifecycleSeparationsByIdCancel200 = z.strictObject({ ok: z.boolean() });

export const PostLifecycleSeparationsByIdComplete200 = z.strictObject({ ok: z.boolean() });

export const PostLifecycleSeparationsByIdExitInterview200 = z.strictObject({ ok: z.boolean() });

export const PostLifecycleSeparationsByIdFnf200 = z.strictObject({ ok: z.boolean() });

export const PostLifecycleSeparationsByIdWithdraw200 = z.strictObject({ ok: z.boolean() });

export const PostLifecycleSeparationsResign201 = z.strictObject({ id: z.string(), noticeDaysRequired: z.number(), shortfallDays: z.number() });

export const PostLifecycleTasksByIdDone200 = z.strictObject({ ok: z.boolean() });

export const PostLifecycleTemplates201 = z.strictObject({ id: z.string() });

export const PostLoansRequests201 = z.strictObject({ id: z.string(), installmentAmount: z.number() });

export const PostLoansRequestsByIdCancel200 = z.strictObject({ ok: z.boolean() });

export const PostLoansRequestsByIdDefer200 = z.strictObject({ ok: z.boolean(), recomputePayroll: z.string() });

export const PostLoansRequestsByIdDisburse200 = z.strictObject({ ok: z.boolean() });

export const PostLoansRequestsByIdRepayment200 = z.strictObject({ closed: z.boolean(), ok: z.boolean() });

export const PostLoansRequestsByIdWithdraw200 = z.strictObject({ ok: z.boolean() });

export const PostNotificationsByIdRead200 = z.strictObject({ ok: z.boolean() });

export const PostNotificationsPushSubscribe201 = z.strictObject({ ok: z.boolean() });

export const PostNotificationsPushUnsubscribe200 = z.strictObject({ ok: z.boolean() });

export const PostNotificationsReadAll200 = z.strictObject({ updated: z.number() });

export const PostOrgDepartments201 = z.strictObject({ id: z.string() });

export const PostOvertimeClaims201 = z.strictObject({ id: z.string() });

export const PostOvertimeClaimsByIdCancel200 = z.strictObject({ ok: z.boolean(), payrollRunToRecompute: z.string().nullable() });

export const PostOvertimeClaimsByIdWithdraw200 = z.strictObject({ ok: z.boolean() });

export const PostPayrollComponents201 = z.strictObject({ id: z.string() });

export const PostPayrollEmployeesByIdSalaries201 = z.strictObject({ id: z.string() });

export const PostPayrollRuns201 = z.strictObject({ id: z.string() });

export const PostPayrollRunsByIdAcknowledgeWarnings200 = z.strictObject({ ok: z.boolean() });

export const PostPayrollRunsByIdAdjustments201 = z.strictObject({ id: z.string() });

export const PostPayrollRunsByIdCancel200 = z.strictObject({ ok: z.boolean() });

export const PostPayrollRunsByIdCompute200 = z.strictObject({
  excluded: z.number().optional(),
  masked: z.boolean().optional(),
  maskedFields: z.array(z.string()).optional(),
  totals: z.strictObject({ deductions: z.number(), employees: z.number(), employerCost: z.number(), gross: z.number(), held: z.number(), net: z.number() }).nullable(),
  warnings: z.number(),
});

export const PostPayrollRunsByIdFinalize200 = z.strictObject({ ok: z.boolean(), payslips: z.number() });

export const PostPayrollRunsByIdHold200 = z.strictObject({ ok: z.boolean() });

export const PostPayrollRunsByIdItemsByEmployeeIdRelease200 = z.strictObject({ ok: z.boolean() });

export const PostPayrollRunsByIdPaid200 = z.strictObject({ ok: z.boolean() });

export const PostPayrollRunsByIdReopen200 = z.strictObject({ ok: z.boolean() });

export const PostPayrollRunsByIdSubmit200 = z.strictObject({ ok: z.boolean() });

export const PostPayrollStatutoryRules201 = z.strictObject({ id: z.string() });

export const PostPayrollStatutoryRulesByIdRetire200 = z.strictObject({ ok: z.boolean() });

export const PostPayrollStatutoryRulesByIdVerify200 = z.strictObject({ ok: z.boolean() });

export const PostPerformanceCycles201 = z.strictObject({ id: z.string() });

export const PostPerformanceCyclesByIdActivate200 = z.strictObject({ ok: z.boolean(), reviews: z.number() });

export const PostPerformanceCyclesByIdClose200 = z.strictObject({ ok: z.boolean() });

export const PostPerformanceCyclesByIdGoalsByEmployeeId201 = z.strictObject({ id: z.string() });

export const PostPerformanceGoalsByIdByAction200 = z.strictObject({ ok: z.boolean() });

export const PostPerformanceReviewsByIdByStep200 = z.strictObject({ ok: z.boolean() });

export const PostPolicies201 = z.strictObject({ id: z.string() });

export const PostPoliciesByIdRetire200 = z.strictObject({ ok: z.boolean() });

export const PostPoliciesByIdVersions201 = z.strictObject({ id: z.string(), versionNo: z.number() });

export const PostPoliciesVersionsByIdAcknowledge200 = z.strictObject({ acknowledgedAt: z.string(), alreadyAcknowledged: z.boolean(), ok: z.boolean() });

export const PostPoliciesVersionsByIdDiscard200 = z.strictObject({ ok: z.boolean() });

export const PostPoliciesVersionsByIdPublish200 = z.strictObject({ notified: z.number(), ok: z.boolean() });

export const PostPoliciesVersionsByIdWithdraw200 = z.strictObject({ ok: z.boolean() });

export const PostRecruitmentApplications201 = z.strictObject({ id: z.string() });

export const PostRecruitmentApplicationsByIdInterviews201 = z.strictObject({ id: z.string() });

export const PostRecruitmentApplicationsByIdMove200 = z.strictObject({ ok: z.boolean(), stage: z.string() });

export const PostRecruitmentApplicationsByIdOffers201 = z.strictObject({ aboveBudget: z.boolean(), id: z.string() });

export const PostRecruitmentCandidates201 = z.strictObject({ id: z.string() });

export const PostRecruitmentCandidatesByIdAnonymize200 = z.strictObject({ ok: z.boolean() });

export const PostRecruitmentInterviewsByIdCancel200 = z.strictObject({ ok: z.boolean() });

export const PostRecruitmentInterviewsByIdFeedback200 = z.strictObject({ interviewCompleted: z.boolean(), ok: z.boolean() });

export const PostRecruitmentOffersByIdByAction200 = z.strictObject({ ok: z.boolean(), status: z.string() });

export const PostRecruitmentOffersByIdHire201 = z.strictObject({ employeeId: z.string(), onboardingChecklistId: z.string().nullable(), requisitionClosed: z.boolean() });

export const PostRecruitmentOffersByIdSubmit200 = z.strictObject({ approvalRequestId: z.string(), ok: z.boolean() });

export const PostRecruitmentRequisitions201 = z.strictObject({ code: z.string(), id: z.string() });

export const PostRecruitmentRequisitionsByIdByAction200 = z.strictObject({ ok: z.boolean(), status: z.string() });

export const PostRecruitmentRequisitionsByIdSubmit200 = z.strictObject({ approvalRequestId: z.string(), ok: z.boolean() });

export const PostReportsSaved201 = z.strictObject({ id: z.string() });

export const PostTenantCompanyImagesByKind201 = z.strictObject({ contentType: z.string(), kind: z.string(), sha256: z.string() });

export const PostTenantDataRightsErasureRequests200 = z.strictObject({
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decisionNote: z.string().nullable(),
  id: z.string(),
  reason: z.string().nullable(),
  report: z.record(z.string(), z.unknown()).nullable(),
  requestedBy: z.string(),
  retainedUntil: z.string().nullable(),
  status: z.string(),
  subjectId: z.string(),
  subjectType: z.string(),
});

export const PostTenantDataRightsErasureRequests201 = z.strictObject({
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decisionNote: z.string().nullable(),
  id: z.string(),
  reason: z.string().nullable(),
  report: z.record(z.string(), z.unknown()).nullable(),
  requestedBy: z.string(),
  retainedUntil: z.string().nullable(),
  status: z.string(),
  subjectId: z.string(),
  subjectType: z.string(),
});

export const PostTenantDataRightsErasureRequestsByIdExecute200 = z.strictObject({
  alreadyDone: z.boolean(),
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decisionNote: z.string().nullable(),
  id: z.string(),
  reason: z.string().nullable(),
  report: z.looseObject({
    auditLog: z.string(),
    erased: z.record(z.string(), z.unknown()),
    filesDeleted: z.number(),
    filesPending: z.number(),
    notLegalAdvice: z.string(),
    retained: z.array(z.looseObject({ basis: z.string(), category: z.string(), label: z.string(), rows: z.number(), tables: z.array(z.string()), until: z.string() })),
  }),
  requestedBy: z.string(),
  retainedUntil: z.string().nullable(),
  status: z.string(),
  subjectId: z.string(),
  subjectType: z.string(),
});

export const PostTenantDataRightsErasureRequestsByIdReject200 = z.strictObject({
  completedAt: z.string().nullable(),
  createdAt: z.string(),
  decidedAt: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decisionNote: z.string().nullable(),
  id: z.string(),
  reason: z.string().nullable(),
  report: z.record(z.string(), z.unknown()).nullable(),
  requestedBy: z.string(),
  retainedUntil: z.string().nullable(),
  status: z.string(),
  subjectId: z.string(),
  subjectType: z.string(),
});

export const PostTenantJobsByKeyRun202 = z.strictObject({ runId: z.string(), status: z.string() });

export const PostTenantRoles201 = z.strictObject({ key: z.string() });

export const PostTenantUsers201 = z.strictObject({ id: z.string(), inviteSent: z.boolean() });

export const PostTenantUsersByIdInvite200 = z.strictObject({ ok: z.boolean() });

export const PostTenantUsersByIdPasswordReset200 = z.strictObject({ ok: z.boolean() });

export const PostTravelRequests201 = z.strictObject({ id: z.string() });

export const PostTravelRequestsByIdAdvancePaid200 = z.strictObject({ ok: z.boolean() });

export const PostTravelRequestsByIdAdvanceReturned200 = z.strictObject({ ok: z.boolean(), outstanding: z.string() });

export const PostTravelRequestsByIdCancel200 = z.strictObject({ advanceOutstanding: z.string().nullable(), ok: z.boolean() });

export const PostTravelRequestsByIdClaim201 = z.strictObject({ existing: z.boolean(), id: z.string() });

export const PostTravelRequestsByIdClose200 = z.strictObject({ ok: z.boolean() });

export const PostTravelRequestsByIdComplete200 = z.strictObject({ ok: z.boolean() });

export const PostTravelRequestsByIdResubmit200 = z.strictObject({ ok: z.boolean() });

export const PostTravelRequestsByIdWithdraw200 = z.strictObject({ ok: z.boolean() });

export const PutAccountingLedgerMap200 = z.strictObject({ ok: z.boolean() });

export const PutAssetsById200 = z.strictObject({ ok: z.boolean() });

export const PutAttendanceDeviceMappingsByDeviceUserId200 = z.strictObject({ reprocessedEvents: z.number() });

export const PutAttendanceGeofencesByBranchId200 = z.strictObject({ ok: z.boolean() });

export const PutAttendanceRosterOverrides200 = z.strictObject({ ok: z.boolean() });

export const PutAttendanceShiftsById200 = z.strictObject({ ok: z.boolean() });

export const PutAuthPreferences200 = z.strictObject({ ok: z.boolean() });

export const PutCasesCommittee200 = z.strictObject({ ok: z.boolean() });

export const PutCompetencyCoursesById200 = z.strictObject({ ok: z.boolean() });

export const PutCompetencyMethodsById200 = z.strictObject({ ok: z.boolean() });

export const PutDocumentsCategoriesById200 = z.strictObject({ ok: z.boolean() });

export const PutEmployeesByIdBankAccount202 = z.strictObject({ approvalRequestId: z.string(), id: z.string(), ok: z.boolean(), pending: z.boolean() });

export const PutEmployeesByIdProfileBySection200 = z.strictObject({ applied: z.boolean() });

export const PutEmployeesByIdProfileBySection202 = z.strictObject({ applied: z.boolean(), approvalId: z.string(), changeId: z.string() });

export const PutExpensesCategoriesById200 = z.strictObject({ ok: z.boolean() });

export const PutExpensesClaimsById200 = z.strictObject({ ok: z.boolean() });

export const PutLeaveTypesById200 = z.strictObject({ ok: z.boolean() });

export const PutLifecycleSeparationsByIdLwd200 = z.strictObject({ ok: z.boolean(), shortfallDays: z.number() });

export const PutLifecycleTemplatesById200 = z.strictObject({ ok: z.boolean() });

export const PutOrgDepartmentsById200 = z.strictObject({ ok: z.boolean() });

export const PutPayrollComponentsById200 = z.strictObject({ ok: z.boolean() });

export const PutPayrollEmployeesByIdStatutory200 = z.strictObject({ ok: z.boolean() });

export const PutPayrollStatutoryRulesById200 = z.strictObject({ ok: z.boolean() });

export const PutPoliciesById200 = z.strictObject({ ok: z.boolean() });

export const PutRecruitmentOffersById200 = z.strictObject({ aboveBudget: z.boolean(), ok: z.boolean() });

export const PutRecruitmentRequisitionsById200 = z.strictObject({ ok: z.boolean() });

export const PutReportsSavedByIdSchedule200 = z.strictObject({ nextRunOn: z.string(), ok: z.boolean() });

export const PutTenantCompany200 = z.strictObject({ changed: z.array(z.string()), ok: z.boolean(), version: z.number() });

export const PutTenantSettingsByKey200 = z.strictObject({ key: z.string(), value: z.union([z.number(), z.boolean(), z.string(), z.array(z.number())]) });

export const PutTenantUsersByIdSalaryLevel200 = z.strictObject({ effectiveLevel: z.number(), level: z.number(), ok: z.boolean() });
