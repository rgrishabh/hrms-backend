/**
 * The data classification registry: every column of the schema has exactly one level, in this one file. A test reads
 * information_schema and fails when a column has neither a level here nor a place on the exempt lists below.
 *
 *   L1  name, designation, department, work email, photo: all employees
 *   L2  manager, joining date, work location, attendance summary: self, manager chain, HR
 *   L3  personal phone and address, date of birth, emergency contacts, leave reasons, documents: self, HR within hierarchy
 *   L4  salary, CTC, payslips, bank account, PAN, Aadhaar, loans and advances, tax declarations: self, authorised roles above them
 *
 * Layer 4 of the configuration model: a product constant, changed by release. Secrets (password hashes, session tokens) are
 * L4 here too: nobody reads them at all, which is stricter than the L4 rule.
 */
export type DataLevel = 'L1' | 'L2' | 'L3' | 'L4';

/** Columns that identify or stamp a row in every table and say nothing about a person. */
export const SYSTEM_COLUMNS: ReadonlySet<string> = new Set(['id', 'tenant_id', 'created_at', 'updated_at', 'version']);
/** Tables of the machinery, with no personal data. */
export const SYSTEM_TABLES: ReadonlySet<string> = new Set(['schema_migrations', 'feature_definitions', 'platform_settings', 'audit_chain_heads', 'job_runs', 'tenant_feature_entitlements', 'tenant_modules']);

export const CLASSIFICATION: Readonly<Record<string, Readonly<Record<string, DataLevel>>>> = {
  accounting_exports: { source_type: 'L2', source_id: 'L2', format: 'L2', voucher_date: 'L2', exported_by: 'L2', total_enc: 'L4' },
  accounting_ledger_map: { map_key: 'L1', ledger_name: 'L1', updated_by: 'L1' },
  admin_setup_tokens: { user_id: 'L3', token_hash: 'L4', expires_at: 'L3', used_at: 'L3' },
  allowance_rates: { kind: 'L1', tier: 'L1', grade: 'L1', vehicle: 'L1', rate: 'L1', effective_from: 'L1', note: 'L1', created_by: 'L1' },
  approval_delegations: { delegator_id: 'L2', delegate_id: 'L2', starts_on: 'L2', ends_on: 'L2', note: 'L2', created_by: 'L2', revoked_at: 'L2', revoked_by: 'L2' },
  approval_requests: { entity_type: 'L2', entity_id: 'L2', requester_id: 'L2', status: 'L2', current_step: 'L2', summary: 'L3', decided_at: 'L2', excluded_user_ids: 'L2', self_approver_id: 'L2' },
  approval_steps: { request_id: 'L2', step_index: 'L2', approver_kind: 'L2', approver_user_id: 'L2', approver_permission: 'L2', status: 'L2', acted_by: 'L2', acted_at: 'L2', comment: 'L3', activated_at: 'L2', escalated_at: 'L2', escalated_to: 'L2', escalated_permission: 'L2', acted_for: 'L2', acted_via: 'L2' },
  asset_assignments: { asset_id: 'L2', employee_id: 'L2', issued_at: 'L2', issued_by: 'L2', condition_out: 'L2', due_back: 'L2', returned_at: 'L2', received_by: 'L2', condition_in: 'L2', outcome: 'L2', acknowledged_at: 'L2' },
  assets: { tag: 'L1', name: 'L1', category: 'L1', serial_number: 'L1', branch_id: 'L1', status: 'L1', purchase_date: 'L1', calibration_due: 'L1', notes: 'L1' },
  attendance_daily: { employee_id: 'L2', work_date: 'L2', shift_id: 'L2', day_type: 'L2', status: 'L2', first_in: 'L2', last_out: 'L2', punch_count: 'L2', worked_minutes: 'L2', late_minutes: 'L2', early_exit_minutes: 'L2', overtime_minutes: 'L2', exceptions: 'L2', policy_snapshot: 'L2', calc_version: 'L2', calculated_at: 'L2', locked: 'L2', leave_fraction: 'L2', leave_type_code: 'L2', duty_fraction: 'L2' },
  attendance_devices: { branch_id: 'L1', serial_number: 'L1', name: 'L1', adapter_key: 'L1', api_key_hash: 'L4', api_key_prefix: 'L1', status: 'L1', last_sync_at: 'L1', last_clock_drift_seconds: 'L1', last_error: 'L1' },
  attendance_events: { employee_id: 'L2', source: 'L2', source_ref: 'L2', device_id: 'L2', device_user_id: 'L2', event_time: 'L2', device_time: 'L2', received_at: 'L2', direction: 'L2', latitude: 'L3', longitude: 'L3', status: 'L2', reject_reason: 'L2', created_by: 'L2', outside_geofence: 'L2' },
  attendance_period_locks: { period_start: 'L1', period_end: 'L1', locked_by: 'L1', locked_at: 'L1' },
  attendance_regularizations: { employee_id: 'L2', work_date: 'L2', requested_in: 'L2', requested_out: 'L2', reason: 'L3', status: 'L2', requested_by: 'L2', decided_at: 'L2' },
  attendance_selfies: { employee_id: 'L3', event_id: 'L3', storage_key: 'L3', content_type: 'L3', size_bytes: 'L3', sha256: 'L3', data_class: 'L3', retain_until: 'L3', erased_at: 'L3' },
  audit_logs: { actor_id: 'L3', actor_type: 'L3', action: 'L3', category: 'L3', target_type: 'L3', target_id: 'L3', setting_key: 'L3', change_metadata: 'L3', request_id: 'L3', ip: 'L3', user_agent: 'L3', chain_seq: 'L3', prev_hash: 'L3', row_hash: 'L3' },
  branch_geofences: { branch_id: 'L1', latitude: 'L1', longitude: 'L1', radius_m: 'L1', updated_by: 'L1' },
  branches: { legal_entity_id: 'L1', code: 'L1', name: 'L1', state: 'L1', city: 'L1', status: 'L1' },
  candidates: { first_name: 'L3', last_name: 'L3', email: 'L3', phone: 'L3', source: 'L3', referred_by: 'L3', current_company: 'L3', current_designation: 'L3', experience_months: 'L3', notice_days: 'L3', expected_ctc: 'L4', location: 'L3', qualification: 'L3', resume_key: 'L3', resume_name: 'L3', resume_type: 'L3', resume_sha256: 'L3', consent_at: 'L3', consent_note: 'L3', retain_until: 'L3', status: 'L3', employee_id: 'L3', created_by: 'L3' },
  case_events: { case_id: 'L3', type: 'L3', text_enc: 'L3', from_status: 'L3', to_status: 'L3', visible_to_complainant: 'L3', actor_user: 'L3', at: 'L3' },
  cases: { kind: 'L3', number: 'L3', category: 'L3', complainant_id: 'L3', complainant_user: 'L3', anonymous: 'L3', respondent_id: 'L3', respondent_text_enc: 'L3', incident_date: 'L3', description_enc: 'L3', late_reason_enc: 'L3', status: 'L3', assignee_user: 'L3', received_at: 'L3', inquiry_due: 'L3', report_due: 'L3', sla_due: 'L3', outcome_enc: 'L3', closed_at: 'L3' },
  checklist_tasks: { checklist_id: 'L2', position: 'L2', title: 'L2', description: 'L2', owner: 'L2', due_date: 'L2', status: 'L2', note: 'L2', done_by: 'L2', done_at: 'L2' },
  checklist_template_tasks: { template_id: 'L1', position: 'L1', title: 'L1', description: 'L1', owner: 'L1', offset_days: 'L1' },
  checklist_templates: { kind: 'L1', name: 'L1', is_default: 'L1', status: 'L1' },
  checklists: { kind: 'L2', employee_id: 'L2', template_id: 'L2', separation_id: 'L2', anchor_date: 'L2', status: 'L2', created_by: 'L2', completed_at: 'L2' },
  competency_assessments: { employee_id: 'L3', method_id: 'L3', activity: 'L3', approach: 'L3', assessed_on: 'L3', result: 'L3', evidence: 'L3', assessor_id: 'L3' },
  departments: { code: 'L1', name: 'L1', parent_id: 'L1', status: 'L1' },
  device_user_mappings: { device_user_id: 'L2', employee_id: 'L2' },
  document_categories: { code: 'L1', name: 'L1', scope: 'L1', employee_visible: 'L1', employee_upload: 'L1', restricted: 'L1', requires_expiry: 'L1', status: 'L1', payroll_related: 'L1' },
  documents: { category_id: 'L3', employee_id: 'L3', title: 'L3', file_name: 'L3', content_type: 'L3', size_bytes: 'L3', sha256: 'L3', storage_key: 'L3', expires_on: 'L3', status: 'L3', uploaded_by: 'L3', archived_at: 'L3', archived_by: 'L3' },
  email_outbox: { to_user_id: 'L3', to_email: 'L3', subject: 'L3', text_body: 'L3', html_body: 'L3', kind: 'L3', dedupe_key: 'L3', status: 'L3', attempts: 'L3', next_attempt_at: 'L3', last_error: 'L3', sent_at: 'L3' },
  employee_addresses: { employee_id: 'L3', kind: 'L3', line1: 'L3', line2: 'L3', city: 'L3', state: 'L3', postal_code: 'L3', country: 'L3' },
  employee_bank_accounts: { employee_id: 'L4', account_holder: 'L4', account_number_enc: 'L4', account_last4: 'L4', ifsc: 'L4', bank_name: 'L4', updated_by: 'L4' },
  employee_bank_changes: { employee_id: 'L4', account_holder: 'L4', account_number_enc: 'L4', account_last4: 'L4', ifsc: 'L4', bank_name: 'L4', status: 'L4', requested_by: 'L4', decided_at: 'L4' },
  employee_education: { employee_id: 'L3', level: 'L3', qualification: 'L3', institution: 'L3', university: 'L3', year_of_passing: 'L3', score: 'L3' },
  employee_emergency_contacts: { employee_id: 'L3', position: 'L3', name: 'L3', relationship: 'L3', phone: 'L3', alt_phone: 'L3' },
  employee_experience: { employee_id: 'L3', employer: 'L3', designation: 'L3', from_date: 'L3', to_date: 'L3', reason_for_leaving: 'L3' },
  employee_loans: { employee_id: 'L2', kind: 'L4', amount: 'L4', installments: 'L4', installment_amount: 'L4', first_period: 'L4', skip_periods: 'L4', purpose: 'L4', status: 'L4', created_by: 'L4', decided_at: 'L4', disbursed_at: 'L4', disbursed_by: 'L4', disbursement_reference: 'L4', closed_at: 'L4', cancelled_by: 'L4', cancel_reason: 'L4' },
  employee_nominees: { employee_id: 'L3', purpose: 'L3', name: 'L3', relationship: 'L3', date_of_birth: 'L3', share_percent: 'L3', guardian_name: 'L3', address: 'L3' },
  employee_profile_changes: { employee_id: 'L3', section: 'L3', items: 'L3', note: 'L3', status: 'L3', requested_by: 'L3', decided_at: 'L3' },
  employee_salaries: { employee_id: 'L2', effective_from: 'L4', reason: 'L4', status: 'L4', created_by: 'L4', approved_at: 'L4', amounts_enc: 'L4', annual_ctc_enc: 'L4' },
  employee_statutory: { employee_id: 'L4', uan: 'L4', pf_member_id: 'L4', pf_excluded: 'L4', esi_ip_number: 'L4', pan_enc: 'L4', pan_last4: 'L4', tax_regime: 'L4', pt_state: 'L4', aadhaar_enc: 'L4', aadhaar_last4: 'L4' },
  employees: { employee_code: 'L1', user_id: 'L2', first_name: 'L1', last_name: 'L1', work_email: 'L1', phone: 'L3', date_of_birth: 'L3', legal_entity_id: 'L2', branch_id: 'L2', department_id: 'L1', designation: 'L1', grade: 'L2', employment_type: 'L2', status: 'L2', reporting_manager_id: 'L2', date_of_joining: 'L2', probation_end_date: 'L2', confirmation_date: 'L2', contract_end_date: 'L2', exit_date: 'L2' },
  expense_categories: { code: 'L1', name: 'L1', description: 'L1', requires_receipt: 'L1', max_amount: 'L1', gst_applicable: 'L1', status: 'L1', calc: 'L1' },
  expense_claims: { employee_id: 'L2', title: 'L2', purpose: 'L2', project: 'L2', status: 'L2', total: 'L2', currency: 'L2', created_by: 'L2', submitted_at: 'L2', approved_at: 'L2', batch_id: 'L2', paid_at: 'L2', payment_reference: 'L2', travel_request_id: 'L2', advance_adjusted: 'L2' },
  expense_items: { claim_id: 'L2', category_id: 'L2', expense_date: 'L2', amount: 'L2', description: 'L2', merchant: 'L2', invoice_number: 'L2', gstin: 'L2', receipt_key: 'L2', receipt_name: 'L2', receipt_type: 'L2', receipt_sha256: 'L2', duplicate_of: 'L2', quantity: 'L2', rate: 'L2', rate_id: 'L2', tier: 'L2', vehicle: 'L2' },
  field_duty_requests: { employee_id: 'L2', start_date: 'L2', end_date: 'L2', day_part: 'L2', purpose: 'L2', place: 'L2', client_name: 'L2', reference: 'L2', reason: 'L3', status: 'L2', outcome: 'L2', outcome_note: 'L2', reported_at: 'L2', created_by: 'L2', decided_at: 'L2', cancelled_by: 'L2', cancel_reason: 'L2', travel_request_id: 'L2' },
  goals: { cycle_id: 'L3', employee_id: 'L3', title: 'L3', description: 'L3', measure: 'L3', weight: 'L3', status: 'L3', progress: 'L3', created_by: 'L3' },
  holidays: { branch_id: 'L1', holiday_date: 'L1', name: 'L1', optional: 'L1' },
  interview_panel: { interview_id: 'L3', user_id: 'L3', rating: 'L3', recommendation: 'L3', notes: 'L3', submitted_at: 'L3' },
  interviews: { application_id: 'L3', round: 'L3', kind: 'L3', scheduled_at: 'L3', duration_min: 'L3', location: 'L3', status: 'L3', created_by: 'L3' },
  job_application_events: { application_id: 'L3', from_stage: 'L3', to_stage: 'L3', note: 'L3', actor_id: 'L3', at: 'L3' },
  job_applications: { requisition_id: 'L3', candidate_id: 'L3', stage: 'L3', rejection_reason: 'L3', created_by: 'L3' },
  job_offers: { application_id: 'L2', designation: 'L2', legal_entity_id: 'L2', branch_id: 'L2', department_id: 'L2', employment_type: 'L2', annual_ctc: 'L4', joining_date: 'L2', probation_months: 'L2', contract_end_date: 'L2', above_budget: 'L2', notes: 'L2', status: 'L2', created_by: 'L2', approved_at: 'L2', sent_at: 'L2', responded_at: 'L2', employee_id: 'L2' },
  job_requisitions: { number: 'L2', title: 'L2', legal_entity_id: 'L2', branch_id: 'L2', department_id: 'L2', designation: 'L2', employment_type: 'L2', positions: 'L2', filled: 'L2', justification: 'L2', budget_ctc_max: 'L4', hiring_manager_id: 'L2', target_date: 'L2', status: 'L2', created_by: 'L2', approved_at: 'L2', closed_at: 'L2' },
  lab_authorization_events: { authorization_id: 'L2', action: 'L2', actor_id: 'L2', reason: 'L2', at: 'L2' },
  lab_authorizations: { employee_id: 'L2', method_id: 'L2', activity: 'L2', status: 'L2', assessment_id: 'L2', requested_by: 'L2', authorized_by: 'L2', authorized_at: 'L2', valid_from: 'L2', review_due: 'L2', ended_at: 'L2', end_reason: 'L2' },
  lab_method_requirements: { method_id: 'L1', course_id: 'L1' },
  lab_methods: { code: 'L1', name: 'L1', standard_ref: 'L1', discipline: 'L1', matrix: 'L1', branch_id: 'L1', review_months: 'L1', status: 'L1' },
  leave_accrual_progress: { employee_id: 'L2', leave_type_id: 'L2', leave_year: 'L2', through_month: 'L2' },
  leave_ledger: { employee_id: 'L3', leave_type_id: 'L3', leave_year: 'L3', entry_type: 'L3', days: 'L3', request_id: 'L3', reference: 'L3', note: 'L3', created_by: 'L3' },
  leave_requests: { employee_id: 'L2', leave_type_id: 'L2', leave_year: 'L2', start_date: 'L2', end_date: 'L2', start_half: 'L2', end_half: 'L2', days: 'L2', reason: 'L3', status: 'L2', requested_by: 'L2', decided_at: 'L2', cancelled_at: 'L2', cancelled_by: 'L2', overlap_legacy: 'L2' },
  leave_types: { code: 'L1', name: 'L1', description: 'L1', paid: 'L1', allow_half_day: 'L1', requires_balance: 'L1', accrual_method: 'L1', annual_entitlement: 'L1', carry_forward_max: 'L1', max_balance: 'L1', count_non_working_days: 'L1', min_notice_days: 'L1', max_consecutive_days: 'L1', eligible_after_days: 'L1', applicable_employment_types: 'L1', status: 'L1' },
  leave_year_closures: { leave_year: 'L1', closed_at: 'L1', closed_by: 'L1', backfilled: 'L1' },
  legal_entities: { name: 'L1', cin: 'L1', gstin: 'L1', state_code: 'L1', status: 'L1' },
  loan_recoveries: { loan_id: 'L4', source: 'L4', payroll_run_id: 'L4', period: 'L4', amount: 'L4', reference: 'L4', recorded_by: 'L4' },
  notifications: { user_id: 'L3', kind: 'L3', title: 'L3', body: 'L3', link: 'L3', dedupe_key: 'L3', read_at: 'L3', feature: 'L3' },
  overtime_claims: { employee_id: 'L2', work_date: 'L2', minutes: 'L2', recorded_minutes: 'L2', payout: 'L2', reason: 'L3', status: 'L2', comp_off_days: 'L2', payroll_run_id: 'L2', created_by: 'L2', decided_at: 'L2', cancelled_by: 'L2', cancel_reason: 'L2' },
  pay_components: { code: 'L1', name: 'L1', kind: 'L1', calc: 'L1', base_codes: 'L1', prorate: 'L1', taxable: 'L1', pf_wage: 'L1', esi_wage: 'L1', position: 'L1', status: 'L1' },
  payroll_adjustments: { run_id: 'L4', employee_id: 'L4', kind: 'L4', label: 'L4', taxable: 'L4', created_by: 'L4', data_enc: 'L4' },
  payroll_items: { run_id: 'L4', employee_id: 'L4', salary_id: 'L4', days_in_period: 'L4', employed_days: 'L4', lop_days: 'L4', paid_days: 'L4', hold: 'L4', calc_version: 'L4', hold_released_at: 'L4', hold_released_by: 'L4', hold_release_reason: 'L4', data_enc: 'L4' },
  payroll_runs: { legal_entity_id: 'L2', period: 'L2', kind: 'L2', employee_id: 'L2', status: 'L2', warnings: 'L2', warnings_acknowledged: 'L2', computed_at: 'L2', created_by: 'L2', approved_at: 'L2', finalized_at: 'L2', paid_at: 'L2', payment_reference: 'L2', computed_by: 'L2', totals_enc: 'L4' },
  performance_reviews: { cycle_id: 'L3', employee_id: 'L3', reviewer_id: 'L3', status: 'L3', self_rating: 'L3', self_comments: 'L3', manager_rating: 'L3', manager_comments: 'L3', goal_ratings: 'L3', final_rating: 'L3', final_comments: 'L3', finalized_by: 'L3', employee_ack_at: 'L3', employee_ack_note: 'L3' },
  policies: { code: 'L1', title: 'L1', category: 'L1', owner: 'L1', status: 'L1', created_by: 'L1' },
  policy_acknowledgements: { version_id: 'L3', employee_id: 'L3', user_id: 'L3', content_sha256: 'L3', acknowledged_at: 'L3', ip: 'L3', user_agent: 'L3' },
  policy_versions: { policy_id: 'L1', version_no: 'L1', status: 'L1', change_summary: 'L1', body: 'L1', file_key: 'L1', file_name: 'L1', file_sha256: 'L1', file_size: 'L1', content_sha256: 'L1', effective_from: 'L1', requires_ack: 'L1', ack_due_days: 'L1', audience_branch_ids: 'L1', audience_department_ids: 'L1', created_by: 'L1', published_by: 'L1', published_at: 'L1' },
  posh_committee_members: { user_id: 'L3', role: 'L3', added_by: 'L3', added_at: 'L3' },
  posh_external_members: { name: 'L3', organization: 'L3', since: 'L3', until: 'L3' },
  probation_reviews: { employee_id: 'L3', probation_end: 'L3', status: 'L3', recommendation: 'L3', extend_months: 'L3', comments: 'L3', submitted_by: 'L3', submitted_at: 'L3', decided_at: 'L3' },
  push_outbox: { to_user_id: 'L3', kind: 'L3', dedupe_key: 'L3', status: 'L3', attempts: 'L3', next_attempt_at: 'L3', last_error: 'L3', sent_at: 'L3' },
  push_subscriptions: { user_id: 'L3', endpoint: 'L3', p256dh: 'L3', auth: 'L3', last_used_at: 'L3' },
  reimbursement_batches: { status: 'L2', total: 'L2', claim_count: 'L2', prepared_by: 'L2', approved_by: 'L2', approved_at: 'L2', paid_by: 'L2', paid_at: 'L2', payment_reference: 'L2' },
  report_schedules: { saved_report_id: 'L3', frequency: 'L3', weekday: 'L3', day_of_month: 'L3', period: 'L3', recipient_ids: 'L3', enabled: 'L3', next_run_on: 'L3', last_run_at: 'L3', last_result: 'L3', created_by: 'L3' },
  report_snapshots: { schedule_id: 'L3', owner_id: 'L3', report_key: 'L3', name: 'L3', params: 'L3', scope: 'L3', columns: 'L3', notes: 'L3', row_count: 'L3', recipient_ids: 'L3', generated_at: 'L3', expires_at: 'L3', data_enc: 'L4', viewer_level: 'L3' },
  review_cycles: { name: 'L1', period_start: 'L1', period_end: 'L1', self_review: 'L1', status: 'L1', created_by: 'L1' },
  roster_assignments: { employee_id: 'L2', pattern_id: 'L2', effective_from: 'L2', effective_to: 'L2', start_day: 'L2', created_by: 'L2' },
  roster_overrides: { employee_id: 'L2', work_date: 'L2', shift_id: 'L2', reason: 'L2', created_by: 'L2' },
  roster_patterns: { code: 'L1', name: 'L1', days: 'L1', status: 'L1', created_by: 'L1' },
  saved_reports: { owner_id: 'L3', report_key: 'L3', name: 'L3', params: 'L3' },
  separations: { employee_id: 'L3', kind: 'L3', reason: 'L3', notice_date: 'L3', requested_lwd: 'L3', notice_days_required: 'L3', approved_lwd: 'L3', shortfall_days: 'L3', waive_shortfall: 'L3', rehire_eligible: 'L3', status: 'L3', exit_interview: 'L3', fnf_status: 'L3', fnf_note: 'L3', initiated_by: 'L3', completed_at: 'L3' },
  sessions: { token_hash: 'L4', csrf_hash: 'L4', user_id: 'L3', ip: 'L3', user_agent: 'L3', last_seen_at: 'L3', expires_at: 'L3', revoked_at: 'L3', mfa_verified_at: 'L3', mfa_failures: 'L3' },
  shift_assignments: { employee_id: 'L2', shift_id: 'L2', effective_from: 'L2', effective_to: 'L2', created_by: 'L2' },
  shifts: { code: 'L1', name: 'L1', start_time: 'L1', end_time: 'L1', break_minutes: 'L1', grace_minutes: 'L1', early_exit_grace_minutes: 'L1', half_day_min_minutes: 'L1', full_day_min_minutes: 'L1', overtime_after_minutes: 'L1', status: 'L1' },
  statutory_rules: { kind: 'L1', scope: 'L1', effective_from: 'L1', effective_to: 'L1', params: 'L1', source_reference: 'L1', status: 'L1', created_by: 'L1', verified_by: 'L1', verified_at: 'L1' },
  tenant_branding: { display_name: 'L1', logo_object_key: 'L1', favicon_object_key: 'L1', primary_color: 'L1', secondary_color: 'L1', login_message: 'L1', email_branding: 'L1', updated_by: 'L1' },
  tenant_domains: { hostname: 'L1', verification_token: 'L4', verification_status: 'L1', verified_at: 'L1', activation_status: 'L1', tls_status: 'L1', is_primary: 'L1', last_error: 'L1' },
  tenant_integrations: { provider_key: 'L1', enabled: 'L1', configuration: 'L1', secret_reference: 'L4', health_status: 'L1', last_verified_at: 'L1', last_error: 'L1', updated_by: 'L1' },
  tenant_roles: { key: 'L1', name: 'L1', permissions: 'L1', description: 'L1', created_by: 'L1', updated_by: 'L1' },
  tenant_settings: { setting_key: 'L1', scope_type: 'L1', scope_id: 'L1', setting_value: 'L1', updated_by: 'L1' },
  tenants: { slug: 'L1', name: 'L1', status: 'L1', locale: 'L1', timezone: 'L1', date_format: 'L1' },
  training_courses: { code: 'L1', name: 'L1', kind: 'L1', description: 'L1', validity_months: 'L1', status: 'L1' },
  training_records: { employee_id: 'L2', course_id: 'L2', completed_on: 'L2', expires_on: 'L2', result: 'L2', trainer: 'L2', provider: 'L2', hours: 'L2', notes: 'L2', status: 'L2', revoked_reason: 'L2', recorded_by: 'L2' },
  travel_requests: { employee_id: 'L2', purpose: 'L2', trip_type: 'L2', origin: 'L2', destination: 'L2', start_date: 'L2', end_date: 'L2', travel_mode: 'L2', accommodation: 'L2', project: 'L2', estimate_travel: 'L2', estimate_stay: 'L2', estimate_local: 'L2', estimate_meals: 'L2', estimate_other: 'L2', estimate_total: 'L2', advance_requested: 'L3', mark_on_duty: 'L2', on_duty_note: 'L2', status: 'L2', advance_paid_amount: 'L3', advance_paid_at: 'L2', advance_paid_by: 'L2', advance_reference: 'L2', recovered_amount: 'L3', recovered_note: 'L2', created_by: 'L2', decided_at: 'L2', completed_at: 'L2', closed_at: 'L2', closed_by: 'L2', cancelled_by: 'L2', cancel_reason: 'L2' },
  user_roles: { user_id: 'L2', role_key: 'L2', scope_type: 'L2', scope_id: 'L2', granted_by: 'L2' },
  users: { email: 'L1', display_name: 'L1', password_hash: 'L4', status: 'L2', failed_logins: 'L2', locked_until: 'L2', mfa_required: 'L2', last_login_at: 'L2', must_change_password: 'L2', email_notifications: 'L2', mfa_secret_enc: 'L4', mfa_pending_secret_enc: 'L4', mfa_enabled_at: 'L2', mfa_recovery_hashes: 'L4', mfa_last_step: 'L2', salary_access_level: 'L4' },
};

export const levelOf = (table: string, column: string): DataLevel | undefined => CLASSIFICATION[table]?.[column];

/** Field names that must never appear in logs, whatever object carries them: request bodies, errors, job results. */
export const LOG_REDACTED_FIELDS: readonly string[] = ['phone', 'alt_phone', 'altPhone', 'dateOfBirth', 'date_of_birth', 'address', 'line1', 'line2', 'postal_code', 'reason', 'pan', 'panLast4', 'pan_last4', 'pan_enc', 'aadhaar', 'aadhaarLast4',
  'aadhaar_last4', 'aadhaar_enc', 'accountNumber', 'account_number', 'account_number_enc', 'account_last4', 'ifsc', 'uan', 'esiIpNumber', 'esi_ip_number', 'pfMemberId', 'pf_member_id', 'amounts', 'amount', 'annualCtc', 'annual_ctc', 'gross', 'net',
  'deductions', 'employerCost', 'employer_cost', 'lines', 'totals', 'salary', 'ctc', 'expectedCtc', 'expected_ctc', 'budgetCtcMax', 'budget_ctc_max', 'password', 'newPassword', 'currentPassword'];
