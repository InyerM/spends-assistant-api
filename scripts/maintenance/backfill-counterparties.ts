/** Run with a management token in the environment; never pass credentials as CLI arguments. */
export interface BackfillOptions {
  project: string;
  owner: string;
  token: string;
  pageSize: number;
  apply: boolean;
}
export async function backfillCounterparties(
  options: BackfillOptions
): Promise<{ processed: number; pages: number; applied: boolean }> {
  if (
    !/^[a-z0-9]{12,30}$/u.test(options.project) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(options.owner) ||
    !Number.isInteger(options.pageSize) ||
    options.pageSize < 1 ||
    options.pageSize > 500
  )
    throw new Error('Invalid backfill parameters');
  const prefix = `BEGIN; SELECT set_config('request.jwt.claim.sub','${options.owner}',true); SELECT set_config('request.jwt.claims','{"sub":"${options.owner}","role":"authenticated"}',true); SET LOCAL ROLE authenticated;`;
  let cursor: string | null = null,
    processed = 0,
    pages = 0;
  for (;;) {
    const after = cursor ? `'${cursor}'::uuid` : 'NULL';
    const body = options.apply
      ? `SELECT public.scan_counterparty_catalog(${after},${options.pageSize}) AS result;`
      : `WITH page AS (SELECT id FROM public.transactions WHERE user_id=auth.uid() AND deleted_at IS NULL AND (${after} IS NULL OR id>${after}) ORDER BY id LIMIT ${options.pageSize}) SELECT jsonb_build_object('processed',count(*),'next',max(id::text),'has_more',EXISTS(SELECT 1 FROM public.transactions WHERE user_id=auth.uid() AND deleted_at IS NULL AND id::text>(SELECT max(id::text) FROM page))) AS result FROM page;`;
    const response = await fetch(
      `https://api.supabase.com/v1/projects/${options.project}/database/query`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${options.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ query: `${prefix}\n${body}\nCOMMIT;` }),
        signal: AbortSignal.timeout(90000)
      }
    );
    if (!response.ok) throw new Error(`Backfill query failed (${response.status})`);
    const rows = (await response.json()) as Array<{
      result: { processed: number; next: string | null; has_more: boolean };
    }>;
    const page = rows[0]?.result;
    if (
      !page ||
      !Number.isSafeInteger(page.processed) ||
      page.processed < 0 ||
      page.processed > options.pageSize
    )
      throw new Error('Invalid scan result');
    processed += page.processed;
    pages++;
    if (!page.has_more) return { processed, pages, applied: options.apply };
    if (
      !page.next ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(page.next) ||
      (cursor && page.next <= cursor)
    )
      throw new Error('Scan cursor stalled');
    cursor = page.next;
  }
}
export function parseBackfillArguments(args: string[], token: string): BackfillOptions {
  const value = (flag: string): string => {
    const index = args.indexOf(flag);
    return index < 0 ? '' : (args[index + 1] ?? '');
  };
  return {
    project: value('--project-ref'),
    owner: value('--owner-id'),
    token,
    pageSize: Number(value('--page-size') || 200),
    apply: args.includes('--apply')
  };
}
if (process.argv[1]?.endsWith('backfill-counterparties.ts')) {
  const token = process.env.SUPABASE_API_TOKEN;
  if (!token) throw new Error('SUPABASE_API_TOKEN is required');
  backfillCounterparties(parseBackfillArguments(process.argv.slice(2), token))
    .then((result) => process.stdout.write(JSON.stringify(result) + '\n'))
    .catch((error) => {
      process.stderr.write(error instanceof Error ? error.message + '\n' : 'Backfill failed\n');
      process.exitCode = 1;
    });
}
