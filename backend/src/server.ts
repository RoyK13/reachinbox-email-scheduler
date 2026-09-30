// API only (the worker runs as a separate process: src/worker.ts).
import { run } from './processes';

void run({ api: true, worker: false });
