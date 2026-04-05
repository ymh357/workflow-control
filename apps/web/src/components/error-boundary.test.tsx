import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ErrorBoundary from "./error-boundary";

const ThrowingChild = () => {
  throw new Error("Test crash");
};

const GoodChild = () => <div>All good</div>;

describe("ErrorBoundary", () => {
  beforeEach(() => {
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it("renders children when no error", () => {
    render(<ErrorBoundary><GoodChild /></ErrorBoundary>);
    expect(screen.getByText("All good")).toBeDefined();
  });

  it("renders fallback UI when child throws", () => {
    render(<ErrorBoundary><ThrowingChild /></ErrorBoundary>);
    expect(screen.getByText("Something went wrong")).toBeDefined();
  });

  it("shows error message in fallback", () => {
    render(<ErrorBoundary><ThrowingChild /></ErrorBoundary>);
    expect(screen.getByText("Test crash")).toBeDefined();
  });

  it("recovers when Try again is clicked", () => {
    let shouldThrow = true;
    const ConditionalThrow = () => {
      if (shouldThrow) throw new Error("First render crash");
      return <div>Recovered</div>;
    };

    render(<ErrorBoundary><ConditionalThrow /></ErrorBoundary>);
    expect(screen.getByText("Something went wrong")).toBeDefined();

    shouldThrow = false;
    fireEvent.click(screen.getByText("Try again"));
    expect(screen.getByText("Recovered")).toBeDefined();
  });

  it("renders custom fallback prop", () => {
    render(
      <ErrorBoundary fallback={<div>Custom error</div>}>
        <ThrowingChild />
      </ErrorBoundary>
    );
    expect(screen.getByText("Custom error")).toBeDefined();
  });
});
