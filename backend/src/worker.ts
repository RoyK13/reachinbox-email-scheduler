// Email worker only. Run 1..N of these; all coordination is in Redis/Postgres.
import { run } from './processes';

void run({ api: false, worker: true });
