import { seedDemoUser } from '../seed';
import { resolveDatabaseUrl } from '../url';

const url = resolveDatabaseUrl();
const summary = await seedDemoUser(url);
console.log(
  `seeded demo user: ${summary.nodes} nodes, ${summary.habits} habits, ` +
    `${summary.edges} edges, ${summary.schedule_blocks} schedule blocks, ` +
    `${summary.time_entries} time entries, ` +
    `${summary.habit_completions} habit completions`,
);
