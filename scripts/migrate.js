// scripts/migrate.js
// Runs all .sql files in migrations/ in order.
// Use locally: `node scripts/migrate.js` after `netlify link` and `netlify env:set NETLIFY_DATABASE_URL ...`
// Or run via Netlify CLI: `netlify dev:exec node scripts/migrate.js` so env is injected.

import { readdir, readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { neon } from '@netlify/neon';

const __dirname = dirname(fileURLToPath(import.meta.url));
const sql = neon(); // reads NETLIFY_DATABASE_URL or DATABASE_URL

async function run() {
  const dir = join(__dirname, '..', 'migrations');
  const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).sort();
  for (const f of files) {
    console.log(`→ Running ${f}`);
    const content = await readFile(join(dir, f), 'utf8');
    // @netlify/neon executes one statement per template tag; for migrations we need raw multi-statement.
    // Workaround: split by semicolons not inside dollar-quoted blocks. Simple approach for our case:
    const statements = content
      .split(/;\s*$/m)
      .map(s => s.trim())
      .filter(s => s && !s.startsWith('--'));
    for (const stmt of statements) {
      try {
        await sql.query(stmt);
      } catch (e) {
        console.error(`  ✗ Statement failed: ${stmt.slice(0, 80)}...`);
        throw e;
      }
    }
    console.log(`  ✓ ${f}`);
  }
  console.log('All migrations applied.');
}

run().catch(e => {
  console.error('Migration failed:', e);
  process.exit(1);
});
