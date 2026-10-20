import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
const catalog = JSON.parse(readFileSync('data/default-categories.json', 'utf8')) as Array<{
  slug: string;
  translations: Record<string, string>;
}>;
it('uses localized financial and everyday category names rather than copied English terms', () => {
  expect(catalog.find((c) => c.slug === 'leasing')?.translations).toEqual({
    en: 'Vehicle leasing',
    es: 'Arrendamiento financiero de vehículo',
    pt: 'Arrendamento mercantil de veículo'
  });
  expect(catalog.find((c) => c.slug === 'hobbies')?.translations.pt).toBe('Passatempos');
  expect(catalog.find((c) => c.slug === 'delivery')?.translations.pt).toBe('Entrega de refeições');
  expect(catalog.find((c) => c.slug === 'software')?.translations.es).toBe(
    'Aplicaciones y programas'
  );
  for (const item of catalog)
    for (const locale of ['en', 'es', 'pt'])
      expect(item.translations[locale]?.trim(), `${item.slug}/${locale}`).toBeTruthy();
});
