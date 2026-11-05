import { z } from 'zod';

/**
 * Response shapes for the OpenAPI document: L4 paths, sign-in, public config, and the self-service paths the frontend uses most.
 * Generated once from what the test suite observed, then kept honest by `registerResponseCheck`: every test app refuses an answer its route's schema does not describe.
 * Strict objects, so a new field fails the suite until it is declared. A field seen only as null or an empty list is `z.unknown()`, because nothing tested says more.
 * Documentation only: the serializer is plain JSON.stringify, so these can never remove a field from an answer.
 */

export const DeleteAuthSessionsById200 = z.strictObject({
  ok: z.boolean(),
});

export const GetAccountingLedgerMap200 = z.strictObject({
  heads: z.array(
    z.strictObject({
      key: z.string(),
      label: z.string(),
    }),
  ),
  items: z.array(z.unknown()),
});

export const GetAccountingPayrollRunsByIdJournal200 = z.strictObject({
  balanced: z.boolean(),
  date: z.string(),
  entries: z.array(
    z.strictObject({
      credit: z.string(),
      debit: z.string(),
      key: z.string(),
      label: z.string(),
      ledger: z.string().nullable(),
    }),
  ),
  missing: z.array(z.string()),
  narration: z.string(),
  number: z.string(),
  total: z.string(),
});

export const GetAccountingReimbursementBatchesByIdJournal200 = z.strictObject({
  balanced: z.boolean(),
  date: z.string(),
  entries: z.array(
    z.strictObject({
      credit: z.string(),
      debit: z.string(),
      key: z.string(),
      label: z.string(),
      ledger: z.string().nullable(),
    }),
  ),
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
      last_export: z.unknown().optional(),
      paid_at: z.unknown().optional(),
      payment_reference: z.unknown().optional(),
      status: z.string(),
      total: z.string(),
    }),
  ),
  runs: z.array(
    z.strictObject({
      excluded: z.number().optional(),
      id: z.string(),
      kind: z.string(),
      last_export: z
        .strictObject({
          at: z.string(),
          by: z.string(),
          format: z.string(),
        })
        .nullable(),
      legal_entity: z.string(),
      masked: z.boolean().optional(),
      maskedFields: z.array(z.string()).optional(),
      period: z.string(),
      status: z.string(),
      totals: z
        .strictObject({
          deductions: z.number(),
          employees: z.number(),
          employerCost: z.number(),
          gross: z.number(),
          held: z.number(),
          net: z.number(),
        })
        .nullable(),
    }),
  ),
});

export const GetApprovalsById200 = z.strictObject({
  created_at: z.string(),
  decided_at: z.string(),
  entity_id: z.string(),
  entity_type: z.string(),
  id: z.string(),
  requester_id: z.string(),
  status: z.string(),
  steps: z.array(
    z.strictObject({
      acted_at: z.string(),
      acted_by_name: z.string(),
      acted_for_name: z.string(),
      acted_via: z.string(),
      approver_kind: z.string(),
      approver_name: z.string(),
      approver_permission: z.unknown().optional(),
      comment: z.unknown().optional(),
      escalated_at: z.string().nullable(),
      escalated_permission: z.unknown().optional(),
      escalated_to_name: z.string().nullable(),
      status: z.string(),
      step_index: z.number(),
    }),
  ),
  summary: z.string(),
});

export const GetApprovalsInbox200 = z.strictObject({
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
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
});

export const GetApprovalsMine200 = z.strictObject({
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
  items: z.array(z.unknown()),
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
      leave_type_code: z.unknown().optional(),
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
    z.strictObject({
      device_time: z.unknown().optional(),
      direction: z.string(),
      event_time: z.string(),
      id: z.string(),
      source: z.string(),
      status: z.string(),
    }),
  ),
  timezone: z.string(),
});

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

/** Someone with no employee record gets only `linked: false`. */
export const GetAttendanceMeToday200 = z.union([AttendanceMeTodayLinked, z.strictObject({ linked: z.literal(false) })]);

export const GetAuthMe200 = z.strictObject({
  capabilities: z.record(z.string(), z.unknown()),
  csrfToken: z.string(),
  mfa: z.strictObject({
    enabled: z.boolean(),
    enrollmentRequired: z.boolean(),
    method: z.string().nullable(),
    pending: z.boolean(),
    suggested: z.boolean(),
  }),
  mode: z.string(),
  organization: z.strictObject({
    id: z.string(),
    name: z.string(),
  }),
  passwordChangeRequired: z.boolean(),
  permissions: z.array(z.string()),
  preferences: z
    .strictObject({
      dateFormat: z.string(),
      emailNotifications: z.boolean(),
      timezone: z.string(),
    })
    .nullable(),
  roles: z.array(
    z.strictObject({
      group: z.string(),
      key: z.string(),
      name: z.string(),
    }),
  ),
  salaryLevel: z.number(),
  user: z.strictObject({
    displayName: z.string(),
    email: z.string(),
    employeeId: z.string().nullable(),
    id: z.string(),
  }),
  views: z.array(
    z.strictObject({
      key: z.string(),
      label: z.string(),
    }),
  ),
});

export const GetAuthMfaMethods200 = z.strictObject({
  enabled: z.boolean(),
  enforced: z.boolean(),
  method: z.unknown().optional(),
  methods: z.array(
    z.strictObject({
      method: z.string(),
      reason: z.string().optional(),
      usable: z.boolean(),
    }),
  ),
  recoveryCodesLeft: z.number(),
});

export const GetAuthSessions200 = z.strictObject({
  items: z.array(
    z.strictObject({
      created_at: z.string(),
      current: z.boolean(),
      expires_at: z.string(),
      id: z.string(),
      ip: z.string(),
      last_seen_at: z.string(),
      mfa_verified: z.boolean(),
      user_agent: z.string(),
    }),
  ),
});

export const GetConfigPublic200 = z.strictObject({
  auth: z.strictObject({
    resetByEmail: z.boolean(),
  }),
  brand: z.strictObject({
    accentColor: z.unknown().optional(),
    country: z.string(),
    currency: z.string(),
    dateFormat: z.string(),
    domain: z.string(),
    faviconUrl: z.string().nullable(),
    financialYearStart: z.string(),
    fontFamily: z.unknown().optional(),
    helpUrl: z.unknown().optional(),
    legalName: z.string(),
    locale: z.string(),
    loginMessage: z.unknown().optional(),
    logoDarkUrl: z.string().nullable(),
    logoUrl: z.string().nullable(),
    name: z.string(),
    primaryColor: z.string(),
    secondaryColor: z.unknown().optional(),
    supportEmail: z.string(),
    supportPhone: z.unknown().optional(),
    timezone: z.string(),
  }),
  features: z.record(z.string(), z.unknown()),
  mfa: z.strictObject({
    available: z.boolean(),
    enforced: z.boolean(),
    methods: z.array(z.string()),
  }),
  mode: z.string(),
  product: z.strictObject({
    name: z.string(),
  }),
});

export const GetDashboard200 = z.strictObject({
  lists: z.array(
    z.strictObject({
      href: z.string().optional(),
      items: z.array(
        z.strictObject({
          date: z.string().optional(),
          primary: z.string(),
          secondary: z.string().optional(),
        }),
      ),
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
      expires_on: z.unknown().optional(),
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

export const GetEmployeesById200 = z.record(z.string(), z.unknown());

export const GetEmployeesByIdBankAccount200 = z
  .strictObject({
    accountHolder: z.string().nullable(),
    accountNumber: z.string().nullable(),
    accountNumberMasked: z.string(),
    bankName: z.unknown().optional(),
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
      bankName: z.unknown().optional(),
      id: z.string(),
      ifsc: z.string(),
      requestedAt: z.string(),
      requestedBy: z.string(),
    })
    .nullable(),
});

export const GetEmployeesByIdProfile200 = z.strictObject({
  edit: z.strictObject({
    addresses: z.string(),
    contacts: z.string(),
    education: z.string(),
    experience: z.string(),
    nominees: z.string(),
  }),
  missing: z.array(z.string()),
  pending: z.array(
    z.strictObject({
      approval_id: z.string(),
      created_at: z.string(),
      id: z.string(),
      items: z.array(
        z.strictObject({
          address: z.unknown().optional(),
          dateOfBirth: z.string(),
          guardianName: z.string().nullable(),
          name: z.string(),
          purpose: z.string(),
          relationship: z.string(),
          sharePercent: z.number(),
        }),
      ),
      note: z.unknown().optional(),
      requested_by_name: z.string(),
      section: z.string(),
    }),
  ),
  sections: z.strictObject({
    addresses: z.array(
      z.strictObject({
        city: z.string(),
        country: z.string(),
        kind: z.string(),
        line1: z.string(),
        line2: z.string().nullable(),
        postalCode: z.string(),
        state: z.string(),
      }),
    ),
    contacts: z.array(
      z.strictObject({
        altPhone: z.unknown().optional(),
        name: z.string(),
        phone: z.string(),
        relationship: z.string(),
      }),
    ),
    education: z.array(z.unknown()),
    experience: z.array(
      z.strictObject({
        designation: z.string(),
        employer: z.string(),
        fromDate: z.string(),
        reasonForLeaving: z.string(),
        toDate: z.string(),
      }),
    ),
    nominees: z.array(
      z.strictObject({
        address: z.unknown().optional(),
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

export const GetEmployeesMe200 = z.record(z.string(), z.unknown());

export const GetExpensesClaims200 = z.strictObject({
  items: z.array(z.unknown()),
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
      duplicate_of: z.unknown().optional(),
      expense_date: z.string(),
      gstin: z.unknown().optional(),
      has_receipt: z.boolean(),
      id: z.string(),
      invoice_number: z.unknown().optional(),
      merchant: z.unknown().optional(),
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
  travel_request_id: z.unknown().optional(),
  updated_at: z.string(),
  version: z.number(),
});

export const GetFieldDutyRequests200 = z.strictObject({
  items: z.array(
    z.strictObject({
      approval_request_id: z.string().nullable(),
      cancel_reason: z.unknown().optional(),
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
  cancel_reason: z.unknown().optional(),
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
  period: z.strictObject({
    end: z.string(),
    start: z.string(),
  }),
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

export const GetLeaveRequests200 = z.strictObject({
  items: z.array(z.unknown()),
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
      applicable_employment_types: z.array(z.unknown()),
      carry_forward_max: z.string(),
      code: z.string(),
      count_non_working_days: z.boolean(),
      description: z.unknown().optional(),
      eligible_after_days: z.number(),
      id: z.string(),
      max_balance: z.string().nullable(),
      max_consecutive_days: z.unknown().optional(),
      min_notice_days: z.number(),
      name: z.string(),
      paid: z.boolean(),
      requires_balance: z.boolean(),
      status: z.string(),
      version: z.number(),
    }),
  ),
});

export const GetLoansRequests200 = z.strictObject({
  items: z.array(
    z.strictObject({
      amount: z.string().nullable(),
      approval_request_id: z.unknown().optional(),
      cancel_reason: z.unknown().optional(),
      closed_at: z.unknown().optional(),
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
      skip_periods: z.array(z.unknown()).nullable(),
      status: z.string(),
    }),
  ),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetLoansRequestsById200 = z.record(z.string(), z.unknown());

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

export const GetNotificationsPushPublicKey200 = z.strictObject({
  publicKey: z.string(),
});

export const GetNotificationsUnreadCount200 = z.strictObject({
  unread: z.number(),
});

export const GetOvertimeClaims200 = z.strictObject({
  items: z.array(
    z.strictObject({
      approval_request_id: z.string().nullable(),
      cancel_reason: z.unknown().optional(),
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
  minutesByStatus: z.strictObject({
    approved: z.number().optional(),
    pending: z.number().optional(),
  }),
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
});

export const GetOvertimeClaimsById200 = z.strictObject({
  approval_request_id: z.string().nullable(),
  cancel_reason: z.unknown().optional(),
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
  payroll_period: z.unknown().optional(),
  payroll_run_id: z.unknown().optional(),
  payroll_status: z.unknown().optional(),
  reason: z.string().nullable(),
  recorded_minutes: z.number(),
  status: z.string(),
  user_id: z.string(),
  work_date: z.string(),
});

export const GetPayrollEmployeesByIdSalaries200 = z.strictObject({
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
  items: z.array(
    z.strictObject({
      amounts: z.record(z.string(), z.number()).nullable(),
      annual_ctc: z.string().nullable(),
      approved_at: z.string(),
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
  leaveBalances: z.array(
    z.strictObject({
      balance: z.string(),
      code: z.string(),
      name: z.string(),
      paid: z.boolean(),
    }),
  ),
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
    logoUrl: z.unknown().optional(),
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
  lines: z
    .array(
      z.strictObject({
        amount: z.number(),
        basis: z.string().optional(),
        code: z.string(),
        kind: z.string(),
        name: z.string(),
      }),
    )
    .nullable(),
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
  items: z.array(
    z.strictObject({
      deductions: z.string(),
      gross: z.string(),
      id: z.string(),
      kind: z.string(),
      net: z.string(),
      period: z.string(),
      status: z.string(),
    }),
  ),
});

export const GetPayrollRuns200 = z.strictObject({
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
  items: z.array(
    z.strictObject({
      computed_at: z.string().nullable(),
      created_by_name: z.string().nullable(),
      employee_name: z.unknown().optional(),
      excluded: z.number().optional(),
      finalized_at: z.string().nullable(),
      id: z.string(),
      kind: z.string(),
      released_count: z.number().nullable(),
      legal_entity_name: z.string().nullable(),
      masked: z.boolean().optional(),
      maskedFields: z.array(z.string()).optional(),
      paid_at: z.string().nullable(),
      payment_reference: z.unknown().optional(),
      period: z.string(),
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
});

export const GetPayrollRunsById200 = z.strictObject({
  page: z.number(),
  pageSize: z.number(),
  total: z.number(),
  adjustments: z.array(
    z.strictObject({
      amount: z.string().nullable(),
      created_by_name: z.string().nullable(),
      employee_id: z.string(),
      id: z.string(),
      kind: z.string(),
      label: z.string().nullable(),
      note: z.unknown().optional(),
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
      masked: z.boolean().optional(),
      maskedFields: z.array(z.string()).optional(),
      hold_released_at: z.string().nullable().optional(),
      id: z.string(),
      lines: z
        .array(
          z.strictObject({
            amount: z.number().nullable(),
            basis: z.string().optional(),
            code: z.string().nullable(),
            kind: z.string(),
            name: z.string(),
          }),
        )
        .nullable(),
      lop_days: z.string().nullable(),
      net: z.string().nullable(),
      paid_days: z.string().nullable(),
      warnings: z.array(z.string()).nullable(),
    }),
  ),
  kind: z.string(),
  legal_entity_id: z.string(),
  released_count: z.number().nullable(),
  legal_entity_name: z.string().nullable(),
  paid_at: z.string().nullable(),
  payment_reference: z.unknown().optional(),
  period: z.string(),
  status: z.string(),
  tenant_id: z.string().nullable(),
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
  masked: z.boolean().optional(),
  maskedFields: z.array(z.string()).optional(),
  warnings: z.number().nullable(),
  warnings_acknowledged: z.boolean().nullable(),
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
      owner: z.string(),
      published_at: z.string(),
      published_version: z.number(),
      published_version_id: z.string(),
      requires_ack: z.boolean(),
      status: z.string(),
      title: z.string(),
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
      published_at: z.string(),
      requires_ack: z.boolean(),
      title: z.string(),
      version_no: z.number(),
    }),
  ),
  overdue: z.number().optional(),
  pending: z.number(),
});

export const GetReportsSnapshots200 = z.strictObject({
  items: z.array(
    z.strictObject({
      expires_at: z.string(),
      generated_at: z.string(),
      id: z.string(),
      name: z.string(),
      owner: z.string(),
      params: z.strictObject({
        asOf: z.string().optional(),
        from: z.string().optional(),
        groupBy: z.string().optional(),
        to: z.string().optional(),
      }),
      report_key: z.string(),
      row_count: z.number(),
      scope: z.string(),
    }),
  ),
});

export const GetReportsSnapshotsById200 = z.strictObject({
  columns: z.array(
    z.strictObject({
      key: z.string(),
      label: z.string(),
      type: z.string(),
    }),
  ),
  generatedAt: z.string(),
  id: z.string(),
  key: z.string(),
  name: z.string(),
  notes: z.array(z.string()),
  params: z.strictObject({
    asOf: z.string().optional(),
    from: z.string().optional(),
    groupBy: z.string().optional(),
    to: z.string().optional(),
  }),
  rows: z.array(z.record(z.string(), z.unknown())),
  scope: z.string(),
  totals: z.record(z.string(), z.unknown()).nullable(),
});

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
  legalName: z.string(),
  masked: z.boolean().optional(),
  maskedFields: z.array(z.string()).optional(),
  panMasked: z.string().nullable(),
  pfRegistration: z.string().nullable().optional(),
  ptRegistration: z.string().nullable().optional(),
  registeredAddress: z.string().nullable(),
  signatoryDesignation: z.string().nullable(),
  signatoryName: z.string().nullable(),
  stored: z.strictObject({
    cin: z.string().nullable(),
    gstin: z.string().nullable(),
    legalName: z.string().nullable(),
  }),
  tan: z.string().nullable(),
  updatedAt: z.string().nullable(),
  version: z.number(),
});

export const GetTravelRequests200 = z.strictObject({
  items: z.array(z.record(z.string(), z.unknown())),
  page: z.number(),
  pageSize: z.number(),
  today: z.string(),
  total: z.number(),
});

export const GetTravelRequestsById200 = z.record(z.string(), z.unknown());

export const PostApprovalsByIdAct200 = z.strictObject({
  status: z.string(),
});

export const PostAttendancePunch200 = z.strictObject({
  direction: z.string().optional(),
  duplicate: z.boolean(),
  eventTime: z.string().optional(),
  id: z.string().optional(),
  outsideGeofence: z.boolean().optional(),
});

export const PostAttendanceSelfies201 = z.strictObject({
  id: z.string(),
});

export const PostAuthLogin200 = z.strictObject({
  csrfToken: z.string(),
  expiresAt: z.string(),
  mfaDelivery: z.string().nullable(),
  mfaMethod: z.string().nullable(),
  mfaRequired: z.boolean(),
  passwordChangeRequired: z.boolean(),
});

export const PostAuthLogout200 = z.strictObject({
  ok: z.boolean(),
});

export const PostAuthMfaDisable200 = z.strictObject({
  csrfToken: z.string(),
  ok: z.boolean(),
});

export const PostAuthMfaEmailEnable200 = z.strictObject({
  csrfToken: z.string(),
  recoveryCodes: z.array(z.string()),
});

export const PostAuthMfaEmailSetup200 = z.strictObject({
  sent: z.boolean(),
});

export const PostAuthMfaEnable200 = z.strictObject({
  csrfToken: z.string(),
  recoveryCodes: z.array(z.string()),
});

export const PostAuthMfaSetup200 = z.strictObject({
  otpauthUri: z.string(),
  secret: z.string(),
});

export const PostAuthMfaVerify200 = z.strictObject({
  csrfToken: z.string(),
  method: z.string(),
  ok: z.boolean(),
});

export const PostAuthPassword200 = z.strictObject({
  csrfToken: z.string(),
  ok: z.boolean(),
});

export const PostAuthPasswordForgot200 = z.strictObject({
  ok: z.boolean(),
});

export const PostAuthPasswordReset200 = z.strictObject({
  ok: z.boolean(),
});

export const PostAuthSessionsRevokeAll200 = z.strictObject({
  ok: z.boolean(),
});

export const PostAuthSetup200 = z.strictObject({
  ok: z.boolean(),
});

export const PostLeaveRequests201 = z.strictObject({
  approvalRequestId: z.string(),
  days: z.string(),
  id: z.string(),
});

export const PostLeaveRequestsByIdCancel200 = z.strictObject({
  ok: z.boolean(),
  reversedDays: z.string(),
});

export const PostLeaveRequestsPreview200 = z.strictObject({
  available: z.string(),
  days: z.string(),
  leaveYear: z.number(),
  paid: z.boolean(),
  perDate: z.array(
    z.strictObject({
      date: z.string(),
      fraction: z.number(),
    }),
  ),
  requiresBalance: z.boolean(),
  sufficient: z.boolean(),
});

export const PostNotificationsByIdRead200 = z.strictObject({
  ok: z.boolean(),
});

export const PostNotificationsPushSubscribe201 = z.strictObject({
  ok: z.boolean(),
});

export const PostNotificationsReadAll200 = z.strictObject({
  updated: z.number(),
});

export const PostPayrollEmployeesByIdSalaries201 = z.strictObject({
  id: z.string(),
});

export const PostPayrollRunsByIdCompute200 = z.strictObject({
  excluded: z.number().optional(),
  masked: z.boolean().optional(),
  maskedFields: z.array(z.string()).optional(),
  totals: z
    .strictObject({
      deductions: z.number(),
      employees: z.number(),
      employerCost: z.number(),
      gross: z.number(),
      held: z.number(),
      net: z.number(),
    })
    .nullable(),
  warnings: z.number(),
});

export const PutAuthPreferences200 = z.strictObject({
  ok: z.boolean(),
});

export const PutPayrollEmployeesByIdStatutory200 = z.strictObject({
  ok: z.boolean(),
});
