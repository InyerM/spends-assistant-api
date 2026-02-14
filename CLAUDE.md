# Spends Assistant Backend — Claude Rules

## CRITICAL PROJECT RULES

### NEVER create middleware.ts in the frontend

**When working on the frontend (`spends-assistant-web/`), NEVER create `middleware.ts` or `middleware.js`.** The project uses `proxy.ts` for auth/session logic and it must NOT be wired up as Next.js middleware. See `spends-assistant-web/CLAUDE.md` for full frontend rules.

### API Route Performance

- Use `Promise.all()` for independent async operations — never sequential awaits
- Return early when validation fails — don't fetch data you won't need
- Always check auth before performing mutations

### Vercel React Best Practices

When working on the frontend (`spends-assistant-web/`), follow ALL rules in `spends-assistant-web/CLAUDE.md`. Key rules:

- **Eliminate waterfalls**: `Promise.all()` for independent ops, defer await until needed
- **Bundle size**: Dynamic imports for heavy components, defer analytics
- **Re-renders**: Derive state during render, functional setState, narrow effect deps
- **Immutability**: Use `.toSorted()` not `.sort()` on React state/props
