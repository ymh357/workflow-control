import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Highlight, themes } from "prism-react-renderer";
import type { Components } from "react-markdown";

const CodeBlock = ({ className, children }: { className?: string; children?: React.ReactNode }) => {
  const match = className?.match(/language-(\w+)/);
  const code = String(children).replace(/\n$/, "");

  if (match) {
    return (
      <Highlight theme={themes.nightOwl} code={code} language={match[1]}>
        {({ style, tokens, getLineProps, getTokenProps }) => (
          <code
            className="block overflow-auto rounded bg-zinc-900 p-3 text-xs font-mono my-2"
            style={{ ...style, background: "transparent" }}
          >
            {tokens.map((line, i) => (
              <div key={i} {...getLineProps({ line })}>
                {line.map((token, key) => (
                  <span key={key} {...getTokenProps({ token })} />
                ))}
              </div>
            ))}
          </code>
        )}
      </Highlight>
    );
  }

  return <code className="rounded bg-zinc-800 px-1.5 py-0.5 text-xs text-zinc-300 font-mono">{children}</code>;
};

const components: Components = {
  h1: ({ children }) => <h1 className="text-base font-bold text-zinc-200 mt-3 mb-1">{children}</h1>,
  h2: ({ children }) => <h2 className="text-sm font-bold text-zinc-200 mt-3 mb-1">{children}</h2>,
  h3: ({ children }) => <h3 className="text-sm font-semibold text-zinc-300 mt-2 mb-1">{children}</h3>,
  p: ({ children }) => <p className="text-sm text-zinc-300 mb-2 leading-relaxed">{children}</p>,
  ul: ({ children }) => <ul className="list-disc list-inside text-sm text-zinc-300 mb-2 space-y-0.5">{children}</ul>,
  ol: ({ children }) => <ol className="list-decimal list-inside text-sm text-zinc-300 mb-2 space-y-0.5">{children}</ol>,
  li: ({ children }) => <li className="text-sm text-zinc-300">{children}</li>,
  code: CodeBlock as Components["code"],
  pre: ({ children }) => <pre className="my-2">{children}</pre>,
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noopener noreferrer" className="text-blue-400 underline hover:text-blue-300">
      {children}
    </a>
  ),
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-zinc-700 pl-3 my-2 text-zinc-400 italic">{children}</blockquote>
  ),
  table: ({ children }) => (
    <div className="overflow-auto my-2">
      <table className="text-xs text-zinc-300 border-collapse">{children}</table>
    </div>
  ),
  th: ({ children }) => <th className="border border-zinc-700 px-2 py-1 text-left text-zinc-400 font-medium bg-zinc-900">{children}</th>,
  td: ({ children }) => <td className="border border-zinc-800 px-2 py-1">{children}</td>,
};

const MarkdownBlock = ({ content }: { content: string }) => (
  <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
    {content}
  </ReactMarkdown>
);

export default MarkdownBlock;
