/** What a command-line tool prints for its operator. Servers and workers log through pino instead. */
export const say = (...parts: unknown[]) => { process.stdout.write(`${parts.join(' ')}\n`); };
export const complain = (...parts: unknown[]) => { process.stderr.write(`${parts.join(' ')}\n`); };
