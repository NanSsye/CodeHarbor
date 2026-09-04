import React, { useState } from "react";
import { copyToClipboard } from "../utils";

interface CodeBlockProps {
  code: string;
  language?: string;
}

export const CodeBlock: React.FC<CodeBlockProps> = ({ code, language = "text" }) => {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    const success = await copyToClipboard(code);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  // Simple tokenized syntax highlighting for common code
  const highlightCode = (text: string, lang: string) => {
    const cleanLang = lang.toLowerCase();
    const lines = text.split("\n");

    return lines.map((line, lineIdx) => {
      // Basic highlighting rules
      const tokens: React.ReactNode[] = [];
      let remaining = line;
      let keyCounter = 0;

      // Match comment
      const commentMatch = remaining.match(/^(\s*)((\/\/|#|--).*)$/);
      if (commentMatch) {
        return (
          <div key={lineIdx} className="code-line">
            <span className="code-gutter">{lineIdx + 1}</span>
            <span className="code-content">
              <span>{commentMatch[1]}</span>
              <span className="syn-comment">{commentMatch[2]}</span>
            </span>
          </div>
        );
      }

      // Tokenize keywords, strings, numbers
      const regex =
        /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b(?:const|let|var|function|return|import|export|from|if|else|switch|case|break|continue|for|while|try|catch|finally|throw|class|new|this|typeof|async|await|package|func|def|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE|true|false|null|undefined)\b|\b\d+(?:\.\d+)?\b|[{}()[\].,;:+\-*/%=<>!&|^~?]+|[a-zA-Z_$][a-zA-Z0-9_$]*)/g;

      let lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = regex.exec(line)) !== null) {
        if (match.index > lastIndex) {
          tokens.push(line.slice(lastIndex, match.index));
        }

        const str = match[0];
        if (/^["'`]/.test(str)) {
          tokens.push(
            <span key={keyCounter++} className="syn-string">
              {str}
            </span>
          );
        } else if (
          /^(const|let|var|function|return|import|export|from|if|else|switch|case|break|continue|for|while|try|catch|finally|throw|class|new|this|typeof|async|await|package|func|def|SELECT|FROM|WHERE|INSERT|UPDATE|DELETE)$/.test(
            str
          )
        ) {
          tokens.push(
            <span key={keyCounter++} className="syn-keyword">
              {str}
            </span>
          );
        } else if (/^(true|false|null|undefined)$/.test(str)) {
          tokens.push(
            <span key={keyCounter++} className="syn-boolean">
              {str}
            </span>
          );
        } else if (/^\d/.test(str)) {
          tokens.push(
            <span key={keyCounter++} className="syn-number">
              {str}
            </span>
          );
        } else if (/^[{}()[\].,;:+\-*/%=<>!&|^~?]+$/.test(str)) {
          tokens.push(
            <span key={keyCounter++} className="syn-operator">
              {str}
            </span>
          );
        } else {
          tokens.push(str);
        }

        lastIndex = regex.lastIndex;
      }

      if (lastIndex < line.length) {
        tokens.push(line.slice(lastIndex));
      }

      return (
        <div key={lineIdx} className="code-line">
          <span className="code-gutter">{lineIdx + 1}</span>
          <span className="code-content">{tokens.length > 0 ? tokens : " "}</span>
        </div>
      );
    });
  };

  return (
    <div className="code-block-container">
      <div className="code-block-header">
        <span className="code-block-lang">{language.toUpperCase()}</span>
        <button
          className="code-copy-btn"
          onClick={handleCopy}
          aria-label="复制代码"
          type="button"
        >
          {copied ? "✓ 已复制" : "复制"}
        </button>
      </div>
      <pre className="code-block-pre">
        <code>{highlightCode(code, language)}</code>
      </pre>
    </div>
  );
};
