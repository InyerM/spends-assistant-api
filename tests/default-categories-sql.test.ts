import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
it('backfills and defaults owner categories without changing money or transfers', async () => {
  const db = new PGlite();
  try {
    await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE ROLE service_role;
 CREATE TABLE categories(id uuid primary key default gen_random_uuid(),user_id uuid,name text,slug text,type text,parent_id uuid,icon text,color text,is_default boolean,is_active boolean default true,deleted_at timestamptz,spending_nature text,translations jsonb,UNIQUE(slug,user_id));
 CREATE TABLE transactions(id uuid primary key default gen_random_uuid(),user_id uuid,category_id uuid,type text,amount numeric,deleted_at timestamptz);
 INSERT INTO transactions(user_id,type,amount) VALUES('00000000-0000-4000-8000-000000000001','expense',10),('00000000-0000-4000-8000-000000000001','income',20),('00000000-0000-4000-8000-000000000001','transfer',30);`);
    await db.exec(
      readFileSync('supabase/migrations/20261019000040_default_uncategorized.sql', 'utf8')
    );
    const read = () =>
      db.query<{ type: string; slug: string | null; amount: string }>(
        `SELECT t.type,c.slug,t.amount FROM transactions t LEFT JOIN categories c ON c.id=t.category_id ORDER BY amount`
      );
    expect((await read()).rows).toEqual([
      { type: 'expense', slug: 'uncategorized', amount: '10' },
      { type: 'income', slug: 'uncategorized-income', amount: '20' },
      { type: 'transfer', slug: null, amount: '30' }
    ]);
    await db.exec(
      `INSERT INTO transactions(user_id,type,amount) VALUES('00000000-0000-4000-8000-000000000002','expense',40);`
    );
    expect(
      (
        await db.query(
          `SELECT count(*) FROM transactions t JOIN categories c ON c.id=t.category_id WHERE c.user_id<>t.user_id`
        )
      ).rows
    ).toEqual([{ count: 0 }]);
    await db.exec(`UPDATE transactions SET type='income' WHERE amount=40;`);
    expect(
      (
        await db.query(
          `SELECT c.type FROM transactions t JOIN categories c ON c.id=t.category_id WHERE amount=40`
        )
      ).rows
    ).toEqual([{ type: 'income' }]);
  } finally {
    await db.close();
  }
}, 15000);
