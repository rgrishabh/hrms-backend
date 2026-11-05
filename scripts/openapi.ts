/** Writes openapi.json from the code. No database: the pool is never asked for a connection. Prints the coverage. */
import { writeFileSync } from 'node:fs';
import { buildSpec, specCoverage } from '../src/core/http/openapi-spec.js';

const out = process.argv[2] ?? 'openapi.json';
const { document, routes } = await buildSpec();
writeFileSync(out, JSON.stringify(document, null, 2) + '\n');
const c = specCoverage(routes);
process.stdout.write(`${out}: ${c.total} routes, ${c.withRequest} with request schemas, ${c.withResponse} with response schemas, ${c.binary} binary\n`);
if (c.withRequest < c.total) {
  process.stderr.write(`${c.total - c.withRequest} routes have no schema\n`);
  process.exitCode = 1;
}
