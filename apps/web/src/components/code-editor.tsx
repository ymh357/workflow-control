"use client";

import { useState } from "react";
import Editor from "@monaco-editor/react";

interface CodeEditorProps {
  value: string;
  language: "yaml" | "markdown" | "typescript" | "json";
  onChange: (value: string | undefined) => void;
  placeholder?: string;
  height?: string;
  readOnly?: boolean;
}

const CodeEditor = ({ value, language, onChange, placeholder, height = "500px", readOnly = false }: CodeEditorProps) => {
  const [isFocused, setIsFocused] = useState(false);

  const showPlaceholder = !value && placeholder && !isFocused;

  return (
    <div 
      className="relative overflow-hidden rounded-md border border-zinc-800 bg-zinc-950"
      style={{ height }}
    >
      {showPlaceholder && (
        <div className="absolute left-12 top-3 z-10 pointer-events-none select-none text-zinc-600 font-mono text-xs leading-relaxed whitespace-pre">
          {placeholder}
        </div>
      )}
      <Editor
        height="100%"
        language={language}
        value={value}
        theme="vs-dark"
        onChange={onChange}
        onMount={(editor) => {
          editor.onDidFocusEditorText(() => setIsFocused(true));
          editor.onDidBlurEditorText(() => setIsFocused(false));
        }}
        options={{
          minimap: { enabled: false },
          fontSize: 12,
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          scrollBeyondLastLine: false,
          automaticLayout: true,
          readOnly,
          padding: { top: 12, bottom: 12 },
          lineNumbers: "on",
          renderLineHighlight: "all",
          tabSize: 2,
          wordWrap: "on",
        }}
      />
    </div>
  );
};

export default CodeEditor;
