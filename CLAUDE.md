# Spends Assistant Backend — Claude Rules

## CRITICAL PROJECT RULES

### Architecture: Handler → Service → BaseService

- **Handlers** (`src/handlers/*.ts`): Thin controllers. One file per route. They:
  1. Call `createSupabaseServices(env)` for dependency injection
  2. Call `resolveUserId()` for auth
  3. Validate input and return early on failure
  4. Call services (in parallel where possible)
  5. Return JSON response
- **Services** (`src/services/supabase/*.ts`): All DB access. Extend `BaseService`. Never call `fetch()` to Supabase outside services
- **`createSupabaseServices()`**: Factory function for DI. All services instantiated here
- **Parsers** (`src/parsers/*.ts`): External API integrations (Gemini AI). Retry logic, caching, response extraction
- **Utils** (`src/utils/*.ts`): Pure functions. Auth, date, formatting, validation

### Performance Rules

- Use `Promise.all()` for independent async operations — never sequential awaits
- Return early when validation fails — don't fetch data you won't need
- Always check auth (`resolveUserId()`) before performing any mutation
- Start promises early, await late in handlers

### SOLID Principles

- **SRP**: Each handler handles ONE route. Each service handles ONE entity. Don't mix concerns
- **OCP**: Add new handlers for new routes. Don't add conditionals to existing handlers
- **DIP**: Handlers depend on services via `createSupabaseServices()`, not on raw `fetch`. Services depend on `BaseService`, not on Supabase internals

### DRY Rules

- Supabase access ONLY through service classes extending `BaseService`
- Auth ONLY through `resolveUserId()` — don't check headers manually
- Date/time utilities in `src/utils/date.ts` — don't create new date helpers inline
- Formatting in `src/utils/formatting.ts`

### Testing Standards

- **Framework**: Vitest 4 with `environment: 'node'`
- **Coverage threshold**: 80% on lines, functions, branches, statements
- **Mock pattern**: Use `createMock*()` factories from `tests/__test-helpers__/factories.ts`
- **Handler tests**: Mock `fetch` globally via `vi.stubGlobal`, use `createMockFetch(responses)` with URL substring keys
- **Service tests**: Mock `fetch` to simulate Supabase REST responses
- **New code must have tests**: No handler, service, or utility without corresponding tests

### Pre-Completion Checklist

Before finishing any prompt, always run:

- `pnpm type-check` to check for TypeScript errors
- `pnpm lint:fix` to fix linting issues
- `pnpm format:fix` to format code
- `pnpm test:run` to ensure no test regressions
