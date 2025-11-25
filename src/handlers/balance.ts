import { createSupabaseServices } from '../services/supabase';
import { Env } from '../types/env';
import { formatCurrency } from '../utils/formatting';

export async function handleBalance(request: Request, env: Env): Promise<Response> {
  try {
    const url = new URL(request.url);
    const pathParts = url.pathname.split('/');
    const accountId = pathParts[2];

    if (!accountId) {
      return new Response(JSON.stringify({ error: 'Account ID required' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    const services = createSupabaseServices(env.SUPABASE_URL, env.SUPABASE_SERVICE_KEY);

    const balance = await services.accounts.getAccountBalance(accountId);

    return new Response(JSON.stringify({
      account_id: accountId,
      balance,
      formatted: formatCurrency(balance),
      timestamp: new Date().toISOString()
    }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' }
    });

  } catch (error: unknown) {
    console.error('[Balance] Error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return new Response(JSON.stringify({ error: errorMessage }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' }
    });
  }
}
