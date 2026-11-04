import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { l3RowFilter, policyViewer, subjectVisible } from '../../core/policy/salary.js';
import type { Db } from '../../db/tx.js';
import { tenantActor, tenantActorAny, type TenantActor } from '../../core/http/context.js';
import { audit } from '../../core/audit/audit.js';
import { badRequest, conflict, forbidden, notFound } from '../../core/http/errors.js';
import { IsoDate, Uuid } from '../../core/http/pagination.js';
import { createApprovalRequest, registerApprovalHandler, cancelRequest } from '../../core/workflow/engine.js';
import { orgToday } from '../competency/service.js';
import { featureOn } from '../lifecycle/service.js';

/**
 * The rest of the employee record: emergency contacts, addresses, nominees, education, previous employment.
 * HR (employees.manage) edits any employee's sections directly. Employees (profile.self) keep their own emergency
 * contacts and addresses up to date directly; their changes to nominees, education and employment history go to HR
 * (profile.approve) and apply when approved. Each section is replaced as a whole.
 */

export const SECTIONS = ['contacts', 'addresses', 'nominees', 'education', 'experience'] as const;
export type Section = typeof SECTIONS[number];
/** Sections an employee changes only through HR approval. */
export const VERIFIED: readonly Section[] = ['nominees', 'education', 'experience'];
export const SECTION_LABEL: Record<Section, string> = {
  contacts: 'Emergency contacts', addresses: 'Addresses', nominees: 'Nominees', education: 'Education', experience: 'Previous employment',
};

const text = (min: number, max: number) => z.string().trim().min(min).max(max);
const optText = (max: number) => z.string().trim().max(max).nullish().transform((v) => v || null);
const Phone = z.string().trim().regex(/^\+?[0-9 -]{10,15}$/, 'Enter a valid phone number');

const Contact = z.object({ name: text(2, 120), relationship: text(2, 40), phone: Phone, altPhone: Phone.nullish().or(z.literal('')).transform((v) => v || null) });
const Address = z.object({
  kind: z.enum(['current', 'permanent']), line1: text(3, 200), line2: optText(200), city: text(2, 80), state: text(2, 80),
  postalCode: text(3, 12), country: text(2, 60).default('India'),
}).superRefine((x, ctx) => {
  if (x.country.toLowerCase() === 'india' && !/^[1-9][0-9]{5}$/.test(x.postalCode)) ctx.addIssue({ code: 'custom', path: ['postalCode'], message: 'Enter a 6-digit PIN code' });
});
export const NOMINEE_PURPOSES = ['pf', 'gratuity', 'insurance', 'other'] as const;
export const PURPOSE_LABEL: Record<typeof NOMINEE_PURPOSES[number], string> = { pf: 'Provident fund', gratuity: 'Gratuity', insurance: 'Insurance', other: 'Other' };
const Nominee = z.object({
  purpose: z.enum(NOMINEE_PURPOSES), name: text(2, 120), relationship: text(2, 40), dateOfBirth: IsoDate.nullish().transform((v) => v ?? null),
  sharePercent: z.number().gt(0).max(100).multipleOf(0.01), guardianName: optText(120), address: optText(300),
});
export const EDUCATION_LEVELS = ['secondary', 'higher_secondary', 'diploma', 'graduate', 'postgraduate', 'doctorate', 'certification', 'other'] as const;
const Education = z.object({
  level: z.enum(EDUCATION_LEVELS), qualification: text(2, 120), institution: text(2, 200), university: optText(200),
  yearOfPassing: z.number().int().min(1950).max(2100).nullish().transform((v) => v ?? null), score: optText(20),
});
const Experience = z.object({ employer: text(2, 200), designation: text(2, 120), fromDate: IsoDate, toDate: IsoDate, reasonForLeaving: optText(300) });

const ITEM: Record<Section, z.ZodTypeAny> = { contacts: Contact, addresses: Address, nominees: Nominee, education: Education, experience: Experience };
const MAX: Record<Section, number> = { contacts: 5, addresses: 2, nominees: 12, education: 15, experience: 20 };

type Emp = { id: string; user_id: string | null; status: string; date_of_joining: string; name: string };

const yearsOld = (dob: string, on: string) => {
  const [y1, m1, d1] = dob.split('-').map(Number); const [y2, m2, d2] = on.split('-').map(Number);
  return y2! - y1! - (m2! < m1! || (m2 === m1 && d2! < d1!) ? 1 : 0);
};

/** Validate a whole section against the employee and today; returns the parsed items. */
export function validateSection(section: Section, raw: unknown, e: Pick<Emp, 'date_of_joining'>, today: string) {
  const items = z.array(ITEM[section]).max(MAX[section], `At most ${MAX[section]} entries`).parse(raw) as Record<string, any>[];
  if (section === 'addresses') {
    const kinds = items.map((x) => x.kind);
    if (new Set(kinds).size !== kinds.length) throw badRequest('Give each kind of address (current, permanent) once');
  }
  if (section === 'nominees') {
    const totals = new Map<string, number>();
    for (const n of items) {
      if (n.dateOfBirth && n.dateOfBirth > today) throw badRequest(`${n.name}: the date of birth is in the future`);
      if (n.dateOfBirth && yearsOld(n.dateOfBirth, today) < 18 && !n.guardianName) throw badRequest(`${n.name} is a minor: name a guardian`);
      totals.set(n.purpose, Math.round(((totals.get(n.purpose) ?? 0) + n.sharePercent) * 100) / 100);
    }
    for (const [p, t] of totals) if (t !== 100) throw badRequest(`${PURPOSE_LABEL[p as keyof typeof PURPOSE_LABEL]} nominee shares add up to ${t}%; they must total 100%`);
  }
  if (section === 'education') {
    const year = Number(today.slice(0, 4));
    for (const x of items) if (x.yearOfPassing && x.yearOfPassing > year + 1) throw badRequest(`${x.qualification}: the year of passing is too far ahead`);
  }
  if (section === 'experience') {
    for (const x of items) {
      if (x.toDate < x.fromDate) throw badRequest(`${x.employer}: the end date is before the start date`);
      if (x.toDate > e.date_of_joining) throw badRequest(`${x.employer}: previous employment must end by the date of joining (${e.date_of_joining})`);
    }
  }
  return items;
}

/** Replace a section with already validated items. */
export async function replaceSection(db: Db, tenantId: string, employeeId: string, section: Section, items: Record<string, any>[]) {
  const T = { contacts: 'employee_emergency_contacts', addresses: 'employee_addresses', nominees: 'employee_nominees', education: 'employee_education', experience: 'employee_experience' }[section];
  await db.query(`DELETE FROM ${T} WHERE tenant_id=$1 AND employee_id=$2`, [tenantId, employeeId]);
  for (const [i, x] of items.entries()) {
    const ins = (cols: string[], vals: unknown[]) => db.query(`INSERT INTO ${T} (tenant_id, employee_id, ${cols.join(',')}) VALUES ($1,$2,${cols.map((_, j) => `$${j + 3}`).join(',')})`, [tenantId, employeeId, ...vals]);
    if (section === 'contacts') await ins(['position', 'name', 'relationship', 'phone', 'alt_phone'], [i + 1, x.name, x.relationship, x.phone, x.altPhone]);
    if (section === 'addresses') await ins(['kind', 'line1', 'line2', 'city', 'state', 'postal_code', 'country'], [x.kind, x.line1, x.line2, x.city, x.state, x.postalCode, x.country]);
    if (section === 'nominees') await ins(['purpose', 'name', 'relationship', 'date_of_birth', 'share_percent', 'guardian_name', 'address'], [x.purpose, x.name, x.relationship, x.dateOfBirth, x.sharePercent, x.guardianName, x.address]);
    if (section === 'education') await ins(['level', 'qualification', 'institution', 'university', 'year_of_passing', 'score'], [x.level, x.qualification, x.institution, x.university, x.yearOfPassing, x.score]);
    if (section === 'experience') await ins(['employer', 'designation', 'from_date', 'to_date', 'reason_for_leaving'], [x.employer, x.designation, x.fromDate, x.toDate, x.reasonForLeaving]);
  }
}

export async function loadSections(db: Db, tenantId: string, employeeId: string) {
  const q = (sql: string) => db.query(sql, [tenantId, employeeId]).then((r) => r.rows);
  // One connection: run the queries one after another.
  const contacts = await q(`SELECT name, relationship, phone, alt_phone AS "altPhone" FROM employee_emergency_contacts WHERE tenant_id=$1 AND employee_id=$2 ORDER BY position`);
  const addresses = await q(`SELECT kind, line1, line2, city, state, postal_code AS "postalCode", country FROM employee_addresses WHERE tenant_id=$1 AND employee_id=$2 ORDER BY kind`);
  const nominees = await q(`SELECT purpose, name, relationship, date_of_birth::text AS "dateOfBirth", share_percent::float AS "sharePercent", guardian_name AS "guardianName", address
       FROM employee_nominees WHERE tenant_id=$1 AND employee_id=$2 ORDER BY purpose, share_percent DESC, name`);
  const education = await q(`SELECT level, qualification, institution, university, year_of_passing AS "yearOfPassing", score FROM employee_education WHERE tenant_id=$1 AND employee_id=$2
       ORDER BY year_of_passing DESC NULLS LAST, qualification`);
  const experience = await q(`SELECT employer, designation, from_date::text AS "fromDate", to_date::text AS "toDate", reason_for_leaving AS "reasonForLeaving"
       FROM employee_experience WHERE tenant_id=$1 AND employee_id=$2 ORDER BY from_date DESC`);
  return { contacts, addresses, nominees, education, experience } as Record<Section, Record<string, unknown>[]>;
}

async function loadEmployee(db: Db, tenantId: string, id: string): Promise<Emp> {
  const e = (await db.query<Emp>(`SELECT id, user_id, status, date_of_joining::text, trim(first_name||' '||coalesce(last_name,'')) AS name
    FROM employees WHERE tenant_id=$1 AND id=$2`, [tenantId, id])).rows[0];
  if (!e) throw notFound('Employee not found');
  return e;
}

/** Who may see an employee's personal details (L3): the employee, and HR above them in the salary hierarchy. */
async function assertCanView(db: Db, a: TenantActor, id: string) {
  if (a.user.employeeId === id && a.has('profile.self')) return;
  if (a.has('employees.read') && await subjectVisible(db, a.tenantId, await policyViewer(db, a.tenantId, a.user), id, l3RowFilter)) return;
  throw notFound('Employee not found');
}

const n = (k: number, one: string, many: string) => `${k} ${k === 1 ? one : many}`;

/** Approval effects. Registered once at startup (core/runtime), whether or not the module's routes are. */
export function registerProfileApprovals() {
  registerApprovalHandler('employee_profile_change', {
    label: 'Personal details change', requesterLink: '/profile',
    async onApproved(db, tenantId, id) {
      const c = (await db.query<{ employee_id: string; section: Section; items: Record<string, any>[]; status: string }>(
        `SELECT employee_id, section, items, status FROM employee_profile_changes WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, id])).rows[0];
      if (!c || c.status !== 'pending') throw conflict('This change is no longer pending');
      const e = await loadEmployee(db, tenantId, c.employee_id);
      // Checked again as of today (a nominee may have come of age, or the joining date may have been corrected).
      const items = validateSection(c.section, c.items, e, await orgToday(db, tenantId));
      await replaceSection(db, tenantId, c.employee_id, c.section, items);
      await db.query(`UPDATE employee_profile_changes SET status='approved', decided_at=now() WHERE tenant_id=$1 AND id=$2`, [tenantId, id]);
    },
    async onRejected(db, tenantId, id, _actorId, status) {
      await db.query(`UPDATE employee_profile_changes SET status=$3, decided_at=now() WHERE tenant_id=$1 AND id=$2 AND status='pending'`, [tenantId, id, status]);
    },
  });
}

export async function profileRoutes(app: FastifyInstance) {

  /** Everything in the personal record, what is awaiting approval, and what is still missing. */
  app.get('/:id/profile', async (req) => {
    const a = tenantActorAny(req, 'profile.self', 'employees.read');
    const { id } = z.object({ id: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      await assertCanView(db, a, id);
      await loadEmployee(db, a.tenantId, id);
      const sections = await loadSections(db, a.tenantId, id);
      const pending = (await db.query(`SELECT c.id, c.section, c.items, c.note, c.created_at, u.display_name AS requested_by_name,
          (SELECT r.id FROM approval_requests r WHERE r.tenant_id=c.tenant_id AND r.entity_type='employee_profile_change' AND r.entity_id=c.id AND r.status='pending') AS approval_id
        FROM employee_profile_changes c JOIN users u ON u.id=c.requested_by WHERE c.tenant_id=$1 AND c.employee_id=$2 AND c.status='pending' ORDER BY c.created_at`, [a.tenantId, id])).rows;
      const missing: string[] = [];
      if (!sections.contacts.length) missing.push('An emergency contact');
      if (!sections.addresses.some((x) => x.kind === 'current')) missing.push('Current address');
      if (!sections.addresses.some((x) => x.kind === 'permanent')) missing.push('Permanent address');
      if (await featureOn(db, a.tenantId, 'payroll.statutory') && !sections.nominees.some((x) => x.purpose === 'pf')) missing.push('A provident fund nominee');
      const self = a.user.employeeId === id;
      // How each section can be changed by this viewer: directly, through HR approval, or not at all.
      const edit = Object.fromEntries(SECTIONS.map((s) => [s, self ? (a.has('profile.self') ? (VERIFIED.includes(s) ? 'approval' : 'direct') : null) : a.has('employees.manage') ? 'direct' : null]));
      return { sections, pending, missing, edit };
    });
  });

  /** Replace a section: directly (HR, or the employee's own contacts and addresses), or as a change for HR to approve. */
  app.put('/:id/profile/:section', async (req, reply) => {
    const a = tenantActorAny(req, 'profile.self', 'employees.manage');
    const { id, section } = z.object({ id: Uuid, section: z.enum(SECTIONS) }).parse(req.params);
    const b = z.object({ items: z.array(z.unknown()), note: optText(500) }).parse(req.body);
    const self = a.user.employeeId === id;
    if (self ? !a.has('profile.self') : !a.has('employees.manage')) throw self ? forbidden() : notFound('Employee not found');
    return a.tx(async (db) => {
      if (!self) await assertCanView(db, a, id);
      const e = await loadEmployee(db, a.tenantId, id);
      const items = validateSection(section, b.items, e, await orgToday(db, a.tenantId));
      if (!self || !VERIFIED.includes(section)) {
        await replaceSection(db, a.tenantId, id, section, items);
        await audit(db, { ...a.auditBase, action: 'employee.profile_updated', targetType: 'employee', targetId: id, metadata: { section, entries: items.length, byEmployee: self } });
        return { applied: true };
      }
      const open = await db.query(`SELECT 1 FROM employee_profile_changes WHERE tenant_id=$1 AND employee_id=$2 AND section=$3 AND status='pending'`, [a.tenantId, id, section]);
      if (open.rowCount) throw conflict(`Your earlier change to ${SECTION_LABEL[section].toLowerCase()} is still awaiting approval; withdraw it to send a new one`);
      const changeId = (await db.query<{ id: string }>(`INSERT INTO employee_profile_changes (tenant_id, employee_id, section, items, note, requested_by)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [a.tenantId, id, section, JSON.stringify(items), b.note, a.user.userId])).rows[0]!.id;
      const approvalId = await createApprovalRequest(db, a.tenantId, { entityType: 'employee_profile_change', entityId: changeId, requesterId: a.user.userId,
        summary: `${e.name}: ${SECTION_LABEL[section].toLowerCase()} (${n(items.length, 'entry', 'entries')})`, steps: [{ kind: 'permission', permission: 'profile.approve' }],
        excludeUserIds: [e.user_id] });
      await audit(db, { ...a.auditBase, action: 'employee.profile_change_requested', targetType: 'employee', targetId: id, metadata: { section, entries: items.length, changeId, approvalId } });
      reply.code(202); return { applied: false, changeId, approvalId };
    });
  });

  /** A proposed change with the section as it is now, for the approver to compare. */
  app.get('/profile-changes/:changeId', async (req) => {
    const a = tenantActorAny(req, 'profile.self', 'profile.approve', 'employees.read');
    const { changeId } = z.object({ changeId: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      const c = (await db.query<{ employee_id: string; section: Section }>(`SELECT c.id, c.employee_id, c.section, c.items, c.note, c.status, c.created_at, c.decided_at,
          trim(e.first_name||' '||coalesce(e.last_name,'')) AS employee_name, e.employee_code
        FROM employee_profile_changes c JOIN employees e ON e.tenant_id=c.tenant_id AND e.id=c.employee_id WHERE c.tenant_id=$1 AND c.id=$2`, [a.tenantId, changeId])).rows[0];
      if (!c || !(c.employee_id === a.user.employeeId || ((a.has('profile.approve') || a.has('employees.read')) && await subjectVisible(db, a.tenantId, await policyViewer(db, a.tenantId, a.user), c.employee_id, l3RowFilter)))) throw notFound('Change not found');
      return { ...c, current: (await loadSections(db, a.tenantId, c.employee_id))[c.section] };
    });
  });

  /** The employee takes back a change still awaiting approval. */
  app.post('/profile-changes/:changeId/withdraw', async (req) => {
    const a = tenantActor(req, 'profile.self');
    const { changeId } = z.object({ changeId: Uuid }).parse(req.params);
    return a.tx(async (db) => {
      const c = (await db.query<{ employee_id: string; status: string; section: string }>(`SELECT employee_id, status, section FROM employee_profile_changes WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [a.tenantId, changeId])).rows[0];
      if (!c || c.employee_id !== a.user.employeeId) throw notFound('Change not found');
      if (c.status !== 'pending') throw conflict(`This change is ${c.status}`);
      const r = (await db.query<{ id: string }>(`SELECT id FROM approval_requests WHERE tenant_id=$1 AND entity_type='employee_profile_change' AND entity_id=$2 AND status='pending'`, [a.tenantId, changeId])).rows[0];
      if (r) await cancelRequest(db, a.tenantId, r.id, a.user.userId, { requestId: a.auditBase.requestId, ip: a.auditBase.ip }, { subjectMayWithdraw: true });
      else await db.query(`UPDATE employee_profile_changes SET status='cancelled', decided_at=now() WHERE tenant_id=$1 AND id=$2`, [a.tenantId, changeId]);
      await audit(db, { ...a.auditBase, action: 'employee.profile_change_withdrawn', targetType: 'employee', targetId: c.employee_id, metadata: { section: c.section, changeId } });
      return { ok: true };
    });
  });
}
