/**
 * Start opening the remembered account's local database before anything else.
 *
 * `main.tsx` imports this FIRST. Modules run in import order, so the database
 * worker, its WASM and the schema setup get going while the rest of the app
 * (the screens, the editor, the graph library) is still being evaluated — and
 * without waiting for the session check, which only answers who is signed in,
 * not what is on this device. `App` picks the same instance up through `dbFor`.
 *
 * If the server then says someone else is signed in, this database is simply
 * not used (`settleBootSession`); opening it cost a worker, nothing more.
 */
import { dbFor } from './powersync';
import { readCachedUser } from './session-boot';

const remembered = readCachedUser();
if (remembered) dbFor(remembered.id);
