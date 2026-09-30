import { config } from 'dotenv';
import path from 'node:path';

// Load test configuration before any src/ module reads process.env.
config({ path: path.resolve(__dirname, '..', '.env.test'), override: true, quiet: true });
