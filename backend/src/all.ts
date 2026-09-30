// API + email worker (+ built frontend) in one process — the single-service
// deployment used on Railway. The worker still coordinates purely through
// Redis/Postgres, so extra worker-only processes can be added at any time.
import { run } from './processes';

void run({ api: true, worker: true });
