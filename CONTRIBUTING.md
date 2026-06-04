# Contributing

## Getting Started

1. Fork the repository
2. Clone your fork
3. Run `npm install`
4. Create a branch: `git checkout -b feat/my-feature`

## Development

```bash
npm run dev        # Start in development mode
npm test            # Run tests
```

### Code Style

- TypeScript with strict mode
- Use `logStore.systemLog()` for logging — not `console.*`
- Follow existing patterns in the codebase
- Keep functions focused and under 80 lines where possible

## Pull Request Process

1. Update tests to cover your changes
2. Run `npm test` — all tests must pass
3. Run `npx aislop scan` — no new blocking issues
4. Update relevant documentation in `docs/` if needed
5. Add a CHANGELOG entry

## Commit Messages

Conventional Commits format:

```
feat(scopes): add new feature
fix(scopes): fix a bug
chore(scopes): maintenance task
docs(scopes): documentation changes
```

## Project Structure

```
src/
├── cli.ts          # CLI entry point
├── index.tsx       # Server entry + routes
├── routes/         # API handlers
├── services/       # Business logic
├── tools/          # Tool calling system
├── types/          # TypeScript types
└── utils/          # Shared utilities
```

## Questions?

Open a GitHub Discussion or issue.
