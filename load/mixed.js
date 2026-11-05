// k6: what a working day looks like. One scenario per head count, chosen by VUS.
//   VUS=100 BASE=http://127.0.0.1:4100 k6 run load/mixed.js
// Sessions come from load/seed.ts, so the run measures the API and not 1000 Argon2 hashes at once; `login` below is a small steady share of real sign-ins.
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate, Counter } from 'k6/metrics';
import { SharedArray } from 'k6/data';

const data = JSON.parse(open('./.sessions.json'));
const sessions = new SharedArray('sessions', () => data.sessions);
const BASE = __ENV.BASE || 'http://127.0.0.1:4100';
const VUS = Number(__ENV.VUS || 100);
const HOLD = __ENV.HOLD || '2m';
const P95_READ = VUS >= 1000 ? 1500 : 300;
const P95_WRITE = VUS >= 1000 ? 2500 : 600;
// THINK=0 takes the pauses out, to find what the machine can do rather than what a day looks like.
const THINK = __ENV.THINK === undefined ? 1 : Number(__ENV.THINK);
const DEBUG = !!__ENV.DEBUG;

const read = new Trend('read_ms', true);
const write = new Trend('write_ms', true);
const report = new Trend('report_ms', true);
const login = new Trend('login_ms', true);
const refused = new Rate('unexpected_status');
const conflicts = new Counter('business_conflicts');

http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 404, 409));

export const options = {
  discardResponseBodies: !DEBUG,
  setupTimeout: '60s',
  scenarios: {
    staff: {
      executor: 'ramping-vus',
      stages: [
        { duration: '30s', target: VUS },
        { duration: HOLD, target: VUS },
        { duration: '15s', target: 0 },
      ],
      gracefulRampDown: '10s',
    },
    // People signing in through the day: a real password check, 5 per second at most.
    signin: { executor: 'constant-arrival-rate', rate: VUS >= 1000 ? 5 : 1, timeUnit: '1s', duration: '2m', preAllocatedVUs: 20, maxVUs: 50, exec: 'signIn', startTime: '30s' },
  },
  thresholds: {
    read_ms: [`p(95)<${P95_READ}`],
    report_ms: [`p(95)<${P95_READ * 4}`],
    write_ms: [`p(95)<${P95_WRITE}`],
    unexpected_status: ['rate<0.01'],
  },
};

const headers = (s) => ({ host: data.host, cookie: `hrms_sid=${s.token}`, 'x-csrf-token': s.csrf, 'content-type': 'application/json', 'user-agent': 'k6' });
const get = (s, path, trend, name) => {
  const r = http.get(`${BASE}/api/v1${path}`, { headers: headers(s), tags: { name: name || path } });
  trend.add(r.timings.duration);
  refused.add(r.status >= 400 && r.status !== 404 && r.status !== 409);
  if (DEBUG && r.status >= 400) console.log(r.status, name || path);
  return r;
};
const post = (s, path, body, name) => {
  const r = http.post(`${BASE}/api/v1${path}`, JSON.stringify(body), { headers: headers(s), tags: { name: name || path }, responseType: 'text' });
  write.add(r.timings.duration);
  refused.add(r.status >= 400 && r.status !== 409);
  if (DEBUG && r.status >= 400) console.log(r.status, name || path, r.body);
  if (r.status === 409) conflicts.add(1);
  return r;
};
const uuid = () => 'xxxxxxxx-xxxx-4xxx-8xxx-xxxxxxxxxxxx'.replace(/x/g, () => ((Math.random() * 16) | 0).toString(16));
const day = (offset) => new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);

export function setup() {
  const hr = sessions.find((s) => s.email.startsWith('hr.head')) || sessions[0];
  const types = http.get(`${BASE}/api/v1/leave/types`, { headers: headers(hr), responseType: 'text' });
  check(types, { 'leave types': (r) => r.status === 200 });
  return { leaveType: JSON.parse(types.body).items.find((t) => !t.requires_balance)?.id };
}

/** The people who read reports and lists of everyone. */
const office = sessions.filter((s) => /hr_admin|hr_executive/.test(s.role));
function hrWork(s) {
  const n = Math.random() * 100;
  if (n < 30) get(s, '/employees?pageSize=100', report, '/employees full');
  else if (n < 50) get(s, '/reports/headcount', report, '/reports/headcount');
  else if (n < 65) get(s, `/reports/attendance_summary?from=${day(-30)}&to=${day(0)}`, report, '/reports/attendance_summary');
  else if (n < 80) get(s, '/lifecycle/separations?scope=all', report, '/lifecycle/separations');
  else if (n < 90) get(s, '/reports/headcount/export.xlsx', report, '/reports/headcount/export.xlsx');
  else get(s, '/approvals/inbox', report, '/approvals/inbox hr');
}

export default function (ctx) {
  // One person in twenty works in HR or payroll.
  if (__VU % 20 === 0 && office.length) {
    hrWork(office[__VU % office.length]);
    if (THINK > 0) sleep(THINK * (1 + Math.random() * 2));
    return;
  }
  const s = sessions[(__VU - 1) % sessions.length];
  const n = Math.random() * 100;
  if (n < 20) get(s, '/notifications/unread-count', read);
  else if (n < 30) get(s, '/auth/me', read);
  else if (n < 45) get(s, '/dashboard', read);
  else if (n < 55) get(s, `/attendance/me?from=${day(-30)}&to=${day(0)}`, read, '/attendance/me');
  else if (n < 65) get(s, '/leave/balances', read);
  else if (n < 72) get(s, '/leave/requests?scope=mine', read, '/leave/requests');
  else if (n < 80) get(s, `/employees?search=${'abcdeghikmnprs'[Math.floor(Math.random() * 14)]}&pageSize=25`, read, '/employees');
  else if (n < 85) get(s, '/approvals/inbox', read);
  else if (n < 93) post(s, '/attendance/punch', { channel: 'web', idempotencyKey: uuid() }, '/attendance/punch');
  else if (n < 97 && ctx.leaveType) {
    // A weekday, so that the request has a working day in it.
    const offset = 200 + 7 * Math.floor(Math.random() * 70) + ((8 - new Date().getUTCDay()) % 7);
    const d = day(offset);
    const r = post(s, '/leave/requests', { leaveTypeId: ctx.leaveType, startDate: d, endDate: d, reason: 'Load test request' }, '/leave/requests POST');
    if (r.status === 201 && r.body) post(s, `/leave/requests/${JSON.parse(r.body).id}/cancel`, {}, '/leave/requests/:id/cancel');
  } else post(s, '/notifications/read-all', {}, '/notifications/read-all');
  // People read what they asked for.
  if (THINK > 0) sleep(THINK * (1 + Math.random() * 2));
}

export function signIn() {
  const s = sessions[Math.floor(Math.random() * sessions.length)];
  const r = http.post(`${BASE}/api/v1/auth/login`, JSON.stringify({ email: s.email, password: data.password }), {
    headers: { host: data.host, 'content-type': 'application/json', 'user-agent': 'k6' },
    tags: { name: '/auth/login' },
  });
  login.add(r.timings.duration);
  refused.add(r.status !== 200);
}

export function handleSummary(d) {
  const row = (m) => {
    const v = d.metrics[m]?.values;
    return v ? { avg: Math.round(v.avg), med: Math.round(v.med), p90: Math.round(v['p(90)']), p95: Math.round(v['p(95)']), max: Math.round(v.max) } : null;
  };
  const summary = {
    vus: VUS,
    requests: d.metrics.http_reqs.values.count,
    rps: Math.round(d.metrics.http_reqs.values.rate),
    failed: d.metrics.http_req_failed.values.rate,
    unexpected: d.metrics.unexpected_status?.values.rate,
    conflicts: d.metrics.business_conflicts?.values.count ?? 0,
    read: row('read_ms'),
    write: row('write_ms'),
    report: row('report_ms'),
    login: row('login_ms'),
    thresholds: Object.fromEntries(
      Object.entries(d.metrics)
        .filter(([, m]) => m.thresholds)
        .map(([k, m]) => [k, Object.values(m.thresholds).every((t) => t.ok)]),
    ),
  };
  return { stdout: JSON.stringify(summary, null, 2) + '\n', [__ENV.OUT || `load/.result-${VUS}.json`]: JSON.stringify(summary) };
}
