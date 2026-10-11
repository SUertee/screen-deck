// Offline fallback for the bundled Node 24 runtime; production uses compiled JS.
import { registerHooks } from 'node:module';

registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(specifier.startsWith('.') && specifier.endsWith('.js') ? `${specifier.slice(0, -3)}.ts` : specifier, context);
  },
});
