import { runMigrations } from '../migrate';
import { resolveDatabaseUrl } from '../url';

const url = resolveDatabaseUrl();
await runMigrations(url);
console.log(`migrations applied: ${url.replace(/:[^:@/]+@/, ':***@')}`);
