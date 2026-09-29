// Lets `node --experimental-strip-types` resolve the extensionless TypeScript imports used in
// this repo, so the harness runs without adding a TypeScript runner dependency.
import { register } from 'node:module';

register(
  'data:text/javascript,' +
    encodeURIComponent(`
export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    const relative = specifier.startsWith('.') || specifier.startsWith('/');
    if (!relative || /\\.[cm]?[jt]s$/.test(specifier) || error?.code !== 'ERR_MODULE_NOT_FOUND') {
      throw error;
    }
    return next(specifier + '.ts', context);
  }
}
`)
);
