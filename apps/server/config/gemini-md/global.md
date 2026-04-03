## Team Standards (auto-injected by Gemini CLI)

- Do not use `any` type — use `unknown` with type guards
- Do not use moment.js — use date-fns
- Do not use axios — use native fetch
- Do not use SWR — use @tanstack/react-query
- State management priority: useState > zustand > @tanstack/react-querys
- All API calls must have error handling
- All new components must be functional components with arrow syntax

## Knowledge Base
Reference materials in .workflow/knowledge/:
- web3-frontend.md — wallet, BigInt, transactions, chain switching
- react-patterns.md — composition, hooks, state management
- security-checklist.md — XSS, eval, secrets, contract safety
- seo-metadata.md — Next.js metadata, Open Graph, JSON-LD
- nextjs-app-router.md — Server/Client components, Server Actions
- tailwind-patterns.md — responsive, dark mode, extraction rules
- frontend-philosophy.md — composition, optimistic updates, portals
- qa-testing.md — test pyramid, isolation, Page Object Model
Read relevant files when the task involves those areas. Do not read all files.

## Web3 Conventions
- Use viem for chain interaction, wagmi for React hooks — never ethers.js
- BigInt arithmetic only: never convert Wei to Number
- All contract calls must handle: user rejection, insufficient funds, RPC failure
- Transaction UI: pending spinner, confirmation count, success/failure toast
- Validate chain ID before contract interaction

## Component Conventions
- UI primitives from shadcn/ui — do not create custom Button/Input/Dialog
- Use cn() (clsx + twMerge) for conditional class composition
- Loading states: Skeleton components, not spinners
- Error boundaries around every route segment

## Gemini CLI Instructions
- Use `GEMINI.md` for project-specific rules.
- Prefer non-interactive mode for automated tasks.
- Always check for existing patterns before implementation.
