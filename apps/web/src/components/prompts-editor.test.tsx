import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PromptsEditor } from "./prompts-editor";

const originalPrompts = {
  "system/a": "original a content",
  "system/b": "original b content",
};

function textareas() {
  return (screen.getAllByRole("textbox") as HTMLElement[]).filter((el) => el.tagName === "TEXTAREA") as HTMLTextAreaElement[];
}
function actorInput() {
  return (screen.getAllByRole("textbox") as HTMLElement[]).find((el) => el.tagName === "INPUT") as HTMLInputElement;
}

describe("PromptsEditor", () => {
  it("renders one textarea per prompt ref, prefilled with original content", () => {
    render(
      <PromptsEditor
        originalPrompts={originalPrompts}
        actor=""
        onActorChange={() => {}}
        onSubmit={() => Promise.resolve({ ok: true })}
      />,
    );
    const tas = textareas();
    expect(tas).toHaveLength(2);
    expect(tas.map((t) => t.value).sort()).toEqual([
      "original a content",
      "original b content",
    ]);
  });

  it("Submit is disabled until a prompt is modified AND actor is non-empty", () => {
    const { rerender } = render(
      <PromptsEditor
        originalPrompts={originalPrompts}
        actor=""
        onActorChange={() => {}}
        onSubmit={() => Promise.resolve({ ok: true })}
      />,
    );
    const btn = screen.getByRole("button", { name: /submit proposal/i }) as HTMLButtonElement;
    expect(btn.disabled).toBe(true);

    fireEvent.change(textareas()[0]!, { target: { value: "changed body" } });
    expect(btn.disabled).toBe(true);

    rerender(
      <PromptsEditor
        originalPrompts={originalPrompts}
        actor="ymh"
        onActorChange={() => {}}
        onSubmit={() => Promise.resolve({ ok: true })}
      />,
    );
    const btnAfter = screen.getByRole("button", { name: /submit proposal/i }) as HTMLButtonElement;
    expect(btnAfter.disabled).toBe(false);
  });

  it("onSubmit receives only modified refs, not the whole prompts map", async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: true });
    render(
      <PromptsEditor
        originalPrompts={originalPrompts}
        actor="ymh"
        onActorChange={() => {}}
        onSubmit={onSubmit}
      />,
    );
    const target = textareas().find((t) => t.value === "original b content")!;
    fireEvent.change(target, { target: { value: "new b body" } });
    fireEvent.click(screen.getByRole("button", { name: /submit proposal/i }));
    await new Promise((r) => setTimeout(r, 0));
    expect(onSubmit).toHaveBeenCalledWith({ "system/b": "new b body" });
  });

  it("renders inline error when onSubmit returns { ok:false, error }", async () => {
    const onSubmit = vi.fn().mockResolvedValue({ ok: false, error: "NO_OP_PROPOSAL: nothing changed" });
    render(
      <PromptsEditor
        originalPrompts={originalPrompts}
        actor="ymh"
        onActorChange={() => {}}
        onSubmit={onSubmit}
      />,
    );
    fireEvent.change(textareas()[0]!, { target: { value: "tweak" } });
    fireEvent.click(screen.getByRole("button", { name: /submit proposal/i }));
    await new Promise((r) => setTimeout(r, 10));
    expect(screen.getByText(/NO_OP_PROPOSAL/)).toBeDefined();
  });

  it("shows 'no editable prompts' state when originalPrompts is empty", () => {
    render(
      <PromptsEditor
        originalPrompts={{}}
        actor=""
        onActorChange={() => {}}
        onSubmit={() => Promise.resolve({ ok: true })}
      />,
    );
    expect(screen.getByText(/no editable prompts/i)).toBeDefined();
    expect(screen.queryByRole("button", { name: /submit proposal/i })).toBeNull();
  });

  it("onActorChange fires when user types in actor input", () => {
    const onActorChange = vi.fn();
    render(
      <PromptsEditor
        originalPrompts={originalPrompts}
        actor="start"
        onActorChange={onActorChange}
        onSubmit={() => Promise.resolve({ ok: true })}
      />,
    );
    fireEvent.change(actorInput(), { target: { value: "ymh" } });
    expect(onActorChange).toHaveBeenCalledWith("ymh");
  });
});
