import { afterEach, expect, it, vi } from 'vitest';
import { DocumentOcrService } from '../../../src/services/supabase/document-ocr.service';
afterEach(() => vi.unstubAllGlobals());
it('returns a safe typed budget rejection', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ message: 'OCR budget exhausted' }, { status: 400 }))
  );
  await expect(
    new DocumentOcrService('https://db', 'secret').reserve(
      'owner',
      'document',
      'claim',
      433527,
      5000000
    )
  ).rejects.toMatchObject({ code: 'CLOUD_PDF_BUDGET_EXCEEDED', status: 429 });
});
it('returns a safe typed stale claim rejection', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ message: 'Document claim unavailable' }, { status: 400 }))
  );
  await expect(
    new DocumentOcrService('https://db', 'secret').reserve(
      'owner',
      'document',
      'claim',
      433527,
      5000000
    )
  ).rejects.toMatchObject({ code: 'CLOUD_PDF_CLAIM_UNAVAILABLE', status: 409 });
});
it('settles unknown billing without pretending the failed call was free', async () => {
  const fetch = vi.fn(async () => Response.json(true));
  vi.stubGlobal('fetch', fetch);
  await new DocumentOcrService('https://db', 'secret').settle('reservation', null);
  expect(JSON.parse(fetch.mock.calls[0][1]!.body as string)).toEqual({
    p_reservation_id: 'reservation',
    p_actual_micros: null
  });
});
