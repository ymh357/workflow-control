import "@testing-library/jest-dom";

// jsdom stubs required by @xyflow/react when mounted inside any test
// file (pipeline-graph.tsx is imported transitively by the kernel-next
// pages). Installed here so every test gets them without each file
// repeating the boilerplate.
class ResizeObserverShim {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
if (typeof globalThis.ResizeObserver === "undefined") {
  (globalThis as unknown as { ResizeObserver: typeof ResizeObserverShim }).ResizeObserver = ResizeObserverShim;
}

if (typeof (globalThis as { DOMMatrixReadOnly?: unknown }).DOMMatrixReadOnly === "undefined") {
  class DOMMatrixShim {
    m22 = 1;
    constructor() { /* no-op */ }
  }
  (globalThis as unknown as { DOMMatrixReadOnly: typeof DOMMatrixShim }).DOMMatrixReadOnly = DOMMatrixShim;
}
