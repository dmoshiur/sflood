import 'dotenv/config';
import { migrateDatabase, requireTurso } from '../server/database.js';

migrateDatabase().then(() => console.log('Turso migrations are up to date.')).catch((error) => {
  console.error(error);
  process.exitCode = 1;
}).finally(async () => {
  if (process.env.TURSO_DATABASE_URL) await requireTurso().close();
});
