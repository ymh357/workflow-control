"use client";

import CodeEditor from "@/components/code-editor";

interface RawYamlEditorProps {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  height?: string;
  readOnly?: boolean;
}

const RawYamlEditor = ({ value, onChange, placeholder, height = "100%", readOnly = false }: RawYamlEditorProps) => {
  return (
    <div className="flex flex-col h-full">
      <CodeEditor
        language="yaml"
        value={value}
        onChange={(val) => onChange(val || "")}
        placeholder={placeholder}
        height={height}
        readOnly={readOnly}
      />
    </div>
  );
};

export default RawYamlEditor;
