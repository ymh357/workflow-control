## Team Standards (auto-injected by workflow)

- Do not use `any` type — use `unknown` with type guards
- Do not use moment.js — use date-fns
- Do not use axios — use native fetch
- Do not use SWR — use @tanstack/react-query
- State management priority: useState > zustand > @tanstack/react-query
- All API calls must have error handling
- All new components must be functional components with arrow syntax

## Component Conventions
- UI primitives from shadcn/ui — do not create custom Button/Input/Dialog
- Use cn() (clsx + twMerge) for conditional class composition
- Loading states: Skeleton components, not spinners
- Error boundaries around every route segment
