import React from "react";
import { CodeBlock } from "./CodeBlock";

interface MarkdownViewProps {
  content: string;
  isStreaming?: boolean;
}

export const MarkdownView: React.FC<MarkdownViewProps> = ({ content, isStreaming }) => {
  if (!content) {
    if (isStreaming) {
      return (
        <div className="markdown-body streaming">
          <span className="streaming-cursor">▊</span>
        </div>
      );
    }
    return null;
  }

  // Parse inline text (bold, italic, code, links)
  const renderInline = (text: string): React.ReactNode[] => {
    const nodes: React.ReactNode[] = [];
    const regex = /(\*\*.*?\*\*|\*.*?\*|`.*?`|\[.*?\]\(.*?\))/g;
    let lastIdx = 0;
    let match: RegExpExecArray | null;
    let keyIdx = 0;

    while ((match = regex.exec(text)) !== null) {
      if (match.index > lastIdx) {
        nodes.push(text.slice(lastIdx, match.index));
      }
      const token = match[0];
      if (token.startsWith("**") && token.endsWith("**") && token.length >= 4) {
        nodes.push(<strong key={keyIdx++}>{token.slice(2, -2)}</strong>);
      } else if (token.startsWith("*") && token.endsWith("*") && token.length >= 2) {
        nodes.push(<em key={keyIdx++}>{token.slice(1, -1)}</em>);
      } else if (token.startsWith("`") && token.endsWith("`") && token.length >= 2) {
        nodes.push(<code key={keyIdx++} className="inline-code">{token.slice(1, -1)}</code>);
      } else if (token.startsWith("[") && token.includes("](") && token.endsWith(")")) {
        const titleMatch = token.match(/\[(.*?)\]\((.*?)\)/);
        if (titleMatch) {
          const href = safeMarkdownHref(titleMatch[2]);
          if (!href) {
            nodes.push(titleMatch[1]);
            lastIdx = regex.lastIndex;
            continue;
          }
          nodes.push(
            <a
              key={keyIdx++}
              href={href}
              target="_blank"
              rel="noreferrer"
              className="md-link"
            >
              {titleMatch[1]}
            </a>
          );
        } else {
          nodes.push(token);
        }
      } else {
        nodes.push(token);
      }
      lastIdx = regex.lastIndex;
    }

    if (lastIdx < text.length) {
      nodes.push(text.slice(lastIdx));
    }

    return nodes;
  };

  function safeMarkdownHref(value: string) {
    const href = value.trim();
    if (!href || /^(?:javascript|data|vbscript):/i.test(href)) return null;
    try {
      const parsed = new URL(href, window.location.href);
      if (!["http:", "https:", "mailto:"].includes(parsed.protocol)) return null;
    } catch {
      return null;
    }
    return href;
  }

  // Parse markdown into blocks
  const parseBlocks = (raw: string) => {
    const blocks: React.ReactNode[] = [];
    const lines = raw.split("\n");
    let i = 0;
    let blockKey = 0;

    while (i < lines.length) {
      const line = lines[i];

      // 1. Fenced code block
      if (line.trim().startsWith("```")) {
        const lang = line.trim().slice(3).trim() || "text";
        const codeLines: string[] = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith("```")) {
          codeLines.push(lines[i]);
          i++;
        }
        if (i < lines.length && lines[i].trim().startsWith("```")) {
          i++; // consume closing ```
        }
        blocks.push(
          <CodeBlock
            key={blockKey++}
            code={codeLines.join("\n")}
            language={lang}
          />
        );
        continue;
      }

      // 2. Headings
      if (line.startsWith("# ")) {
        blocks.push(<h1 key={blockKey++}>{renderInline(line.slice(2))}</h1>);
        i++;
        continue;
      }
      if (line.startsWith("## ")) {
        blocks.push(<h2 key={blockKey++}>{renderInline(line.slice(3))}</h2>);
        i++;
        continue;
      }
      if (line.startsWith("### ")) {
        blocks.push(<h3 key={blockKey++}>{renderInline(line.slice(4))}</h3>);
        i++;
        continue;
      }
      if (line.startsWith("#### ")) {
        blocks.push(<h4 key={blockKey++}>{renderInline(line.slice(5))}</h4>);
        i++;
        continue;
      }

      // 3. Blockquotes
      if (line.startsWith("> ")) {
        const quoteLines: string[] = [];
        while (i < lines.length && lines[i].startsWith("> ")) {
          quoteLines.push(lines[i].slice(2));
          i++;
        }
        blocks.push(
          <blockquote key={blockKey++} className="md-quote">
            {quoteLines.map((ql, qIdx) => (
              <p key={qIdx}>{renderInline(ql)}</p>
            ))}
          </blockquote>
        );
        continue;
      }

      // 4. Unordered List
      if (/^[-*+]\s+/.test(line)) {
        const listItems: string[] = [];
        while (i < lines.length && /^[-*+]\s+/.test(lines[i])) {
          listItems.push(lines[i].replace(/^[-*+]\s+/, ""));
          i++;
        }
        blocks.push(
          <ul key={blockKey++} className="md-list">
            {listItems.map((item, itemIdx) => (
              <li key={itemIdx}>{renderInline(item)}</li>
            ))}
          </ul>
        );
        continue;
      }

      // 5. Ordered List
      if (/^\d+\.\s+/.test(line)) {
        const listItems: string[] = [];
        while (i < lines.length && /^\d+\.\s+/.test(lines[i])) {
          listItems.push(lines[i].replace(/^\d+\.\s+/, ""));
          i++;
        }
        blocks.push(
          <ol key={blockKey++} className="md-ol">
            {listItems.map((item, itemIdx) => (
              <li key={itemIdx}>{renderInline(item)}</li>
            ))}
          </ol>
        );
        continue;
      }

      // 6. Horizontal Rule
      if (/^(\*\*\*|---|___)$/.test(line.trim())) {
        blocks.push(<hr key={blockKey++} className="md-hr" />);
        i++;
        continue;
      }

      // 7. Table support (simple)
      if (line.includes("|") && lines[i + 1] && /\|?\s*[-:]+[-| :]*\s*\|?/.test(lines[i + 1])) {
        const headerCells = line.split("|").map((c) => c.trim()).filter(Boolean);
        i += 2; // skip header and divider
        const rows: string[][] = [];
        while (i < lines.length && lines[i].includes("|")) {
          const cells = lines[i].split("|").map((c) => c.trim()).filter(Boolean);
          if (cells.length > 0) rows.push(cells);
          i++;
        }
        blocks.push(
          <div key={blockKey++} className="table-responsive">
            <table className="md-table">
              <thead>
                <tr>
                  {headerCells.map((hc, hIdx) => (
                    <th key={hIdx}>{renderInline(hc)}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row, rIdx) => (
                  <tr key={rIdx}>
                    {row.map((cell, cIdx) => (
                      <td key={cIdx}>{renderInline(cell)}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
        continue;
      }

      // 8. Paragraph
      if (!line.trim()) {
        i++;
        continue;
      }

      const pLines: string[] = [];
      while (
        i < lines.length &&
        lines[i].trim() &&
        !lines[i].startsWith("```") &&
        !lines[i].startsWith("#") &&
        !lines[i].startsWith("> ") &&
        !/^[-*+]\s+/.test(lines[i]) &&
        !/^\d+\.\s+/.test(lines[i]) &&
        !/^(\*\*\*|---|___)$/.test(lines[i].trim())
      ) {
        pLines.push(lines[i]);
        i++;
      }

      blocks.push(
        <p key={blockKey++} className="md-p">
          {renderInline(pLines.join(" "))}
        </p>
      );
    }

    return blocks;
  };

  return (
    <div className={`markdown-body ${isStreaming ? "is-streaming" : ""}`}>
      {parseBlocks(content)}
      {isStreaming && <span className="streaming-cursor">▊</span>}
    </div>
  );
};
