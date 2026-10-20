import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
it('updates previously seeded labels while preserving custom translations, IDs and referenced transactions', async () => {
  const db = new PGlite();
  try {
    await db.exec(
      `CREATE ROLE authenticated;CREATE ROLE anon;CREATE ROLE service_role;CREATE TYPE spending_nature AS ENUM('none','want','need','must');CREATE TABLE categories(id uuid primary key default gen_random_uuid(),user_id uuid,name text,slug text,type text,parent_id uuid,icon text,color text,is_default boolean,is_active boolean default true,deleted_at timestamptz,spending_nature spending_nature,translations jsonb,UNIQUE(slug,user_id));CREATE TABLE transactions(id uuid primary key default gen_random_uuid(),category_id uuid references categories(id),amount numeric,raw_text text);INSERT INTO categories(user_id,name,slug,type,is_default,translations) VALUES('00000000-0000-4000-8000-000000000001','Leasing','leasing','expense',true,'{"en":"Leasing","es":"Leasing","pt":"Leasing"}');`
    );
    await db.exec(readFileSync('supabase/migrations/20261019000130_category_catalog.sql', 'utf8'));
    const original = (
      await db.query<{ id: string }>(`SELECT id FROM categories WHERE slug='leasing'`)
    ).rows[0].id;
    await db.exec(
      `UPDATE categories SET translations='{"en":"Hobbies","es":"My personal label","pt":"Hobbies"}' WHERE slug='hobbies';`
    );
    await db.query(
      `INSERT INTO transactions(category_id,amount,raw_text) VALUES($1,100,'Original evidence')`,
      [original]
    );
    await db.query(
      `INSERT INTO categories(user_id,name,slug,type,is_default,translations) VALUES('00000000-0000-4000-8000-000000000002','Leasing','leasing','expense',false,'{"en":"Leasing","es":"Leasing","pt":"Leasing"}')`
    );
    await db.exec(
      readFileSync('supabase/migrations/20261020000010_category_catalog_labels.sql', 'utf8')
    );
    expect(
      (
        await db.query(
          `SELECT name,translations->>'es' AS label FROM categories WHERE NOT is_default AND slug='leasing'`
        )
      ).rows
    ).toEqual([{ name: 'Leasing', label: 'Arrendamiento financiero de vehículo' }]);

    expect(
      (
        await db.query(
          `SELECT id,translations->>'es' AS label FROM categories WHERE slug='leasing' AND is_default`
        )
      ).rows
    ).toEqual([{ id: original, label: 'Arrendamiento financiero de vehículo' }]);
    expect(
      (
        await db.query(
          `SELECT translations->>'es' AS label FROM categories WHERE slug='subscriptions' AND user_id='00000000-0000-4000-8000-000000000001'`
        )
      ).rows
    ).toEqual([{ label: 'Suscripciones y entretenimiento digital' }]);
    expect(
      (
        await db.query(
          `SELECT translations->>'es' AS label FROM categories WHERE slug='hobbies' AND user_id='00000000-0000-4000-8000-000000000001'`
        )
      ).rows
    ).toEqual([{ label: 'My personal label' }]);
    expect((await db.query(`SELECT category_id,amount,raw_text FROM transactions`)).rows).toEqual([
      { category_id: original, amount: '100', raw_text: 'Original evidence' }
    ]);
  } finally {
    await db.close();
  }
}, 15000);
