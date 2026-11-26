/**
 * Imported first by the large-file suites. The app config requires DATABASE_URL at load time; these suites never
 * touch a database, so it points at a port nothing listens on. The project's .env (the production database) is
 * never needed and never used here.
 */
process.env['DATABASE_URL'] ??= 'postgresql://never:never@127.0.0.1:1/never';
process.env['VAULT_MASTER_SECRET'] ??= 'large-file-test-secret';
export {};
