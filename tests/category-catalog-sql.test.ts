import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { expect, it } from 'vitest';
it('seeds all three languages and safely organizes only untouched default categories', async () => {
  const db = new PGlite();
  try {
    await db.exec(
      `CREATE ROLE authenticated;CREATE ROLE anon;CREATE ROLE service_role;CREATE TYPE spending_nature AS ENUM('none','want','need','must');CREATE TABLE categories(id uuid primary key default gen_random_uuid(),user_id uuid,name text,slug text,type text,parent_id uuid,icon text,color text,is_default boolean,is_active boolean default true,deleted_at timestamptz,spending_nature spending_nature,translations jsonb,UNIQUE(slug,user_id));`
    );
    const owner = '00000000-0000-4000-8000-000000000001';
    const catalog = JSON.parse(readFileSync('data/default-categories.json', 'utf8')) as Array<{
      slug: string;
      legacy: { name: string; translations: Record<string, string> } | null;
    }>;
    const legacy = catalog.find((item) => item.slug === 'restaurant')!.legacy!;
    const root = (
      await db.query<{ id: string }>(
        `INSERT INTO categories(user_id,name,slug,type,is_default) VALUES($1,'Food & Drinks','food-drinks','expense',true) RETURNING id`,
        [owner]
      )
    ).rows[0].id;
    const original = (
      await db.query<{ id: string }>(
        `INSERT INTO categories(user_id,name,slug,type,is_default,parent_id,translations) VALUES($1,$2,'restaurant','expense',true,$3,$4) RETURNING id`,
        [owner, legacy.name, root, JSON.stringify(legacy.translations)]
      )
    ).rows[0].id;
    await db.exec(readFileSync('supabase/migrations/20261019000130_category_catalog.sql', 'utf8'));
    expect((await db.query(`SELECT id,name FROM categories WHERE slug='restaurant'`)).rows).toEqual(
      [{ id: original, name: 'Restaurants' }]
    );
    await db.query('SELECT seed_default_categories($1)', [owner]);
    expect(
      (
        await db.query(
          `SELECT count(*) FROM categories WHERE translations ?& array['es','en','pt']`
        )
      ).rows
    ).toEqual([{ count: 94 }]);
    await db.exec(
      `UPDATE categories SET name='My special category',translations='{"es":"Personal"}' WHERE user_id='${owner}' AND slug='restaurant';`
    );
    await db.query('SELECT seed_default_categories($1)', [owner]);
    expect((await db.query(`SELECT name FROM categories WHERE slug='restaurant'`)).rows).toEqual([
      { name: 'My special category' }
    ]);
    expect(
      (
        await db.query(
          `SELECT parent.slug FROM categories child JOIN categories parent ON parent.id=child.parent_id WHERE child.slug='drugstore'`
        )
      ).rows
    ).toEqual([{ slug: 'health' }]);
    expect((await db.query(`SELECT count(*) FROM categories`)).rows).toEqual([{ count: 94 }]);
  } finally {
    await db.close();
  }
}, 15000);
