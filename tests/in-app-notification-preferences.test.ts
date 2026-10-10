import { PGlite } from '@electric-sql/pglite';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
it('suppresses only disabled in-app categories for their owner while retaining financial review notices', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE SCHEMA auth; CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$ SELECT '00000000-0000-4000-8000-000000000001'::uuid $$;
 CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
 CREATE TABLE product_preferences(user_id uuid,payload jsonb);
 CREATE TABLE owner_notifications(user_id uuid,kind text);
 INSERT INTO product_preferences VALUES(auth.uid(),'{"in_app_notifications":{"email":false,"budgets":false,"schedules":false}}');`);
    await db.exec(
      readFileSync('supabase/migrations/20261010000058_in_app_notification_preferences.sql', 'utf8')
    );
    await db.exec(
      `INSERT INTO owner_notifications VALUES(auth.uid(),'email_received'),(auth.uid(),'budget_near'),(auth.uid(),'scheduled_due'),(auth.uid(),'scheduled_review'),(auth.uid(),'goal_reached'),('00000000-0000-4000-8000-000000000002','email_received');`
    );
    const result = await db.query<{ kind: string }>('SELECT kind FROM owner_notifications');
    expect(result.rows.map((row) => row.kind)).toEqual([
      'scheduled_review',
      'goal_reached',
      'email_received'
    ]);
  } finally {
    await db.close();
  }
});
