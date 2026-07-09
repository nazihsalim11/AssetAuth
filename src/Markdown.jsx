import React from 'react';

/**
 * A deliberately small Markdown renderer for Knowledge Base articles.
 *
 * It builds React elements directly and never parses or injects HTML — there is no
 * dangerouslySetInnerHTML anywhere — so an article body cannot introduce script,
 * iframes, or event handlers no matter what an author types. That is the whole reason
 * the KB stores Markdown rather than HTML.
 *
 * Supported: # headings, **bold**, *italic*, `code`, ```fenced blocks```,
 * - bullets, 1. numbered lists, [links](url), > quotes, --- rules.
 * Anything else renders as literal text, which is the safe failure mode.
 */

const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;

// Only http(s) and mailto links are rendered as anchors. `javascript:` and `data:`
// URLs fall through to plain text.
const isSafeHref = (href) => /^(https?:\/\/|mailto:|\/)/i.test(href.trim());

function renderInline(text, keyPrefix) {
  const parts = String(text).split(INLINE).filter(Boolean);
  return parts.map((part, i) => {
    const key = `${keyPrefix}-${i}`;

    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      return <strong key={key}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith('*') && part.endsWith('*') && part.length > 2) {
      return <em key={key}>{part.slice(1, -1)}</em>;
    }
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      return (
        <code
          key={key}
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.9em',
            background: 'var(--bg-subtle)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-xs)',
            padding: '1px 5px'
          }}
        >
          {part.slice(1, -1)}
        </code>
      );
    }

    const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(part);
    if (link) {
      const [, label, href] = link;
      if (!isSafeHref(href)) return <span key={key}>{part}</span>;
      return (
        <a key={key} href={href} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--primary)' }}>
          {label}
        </a>
      );
    }

    return <span key={key}>{part}</span>;
  });
}

const Markdown = ({ children }) => {
  const source = String(children || '');
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks = [];

  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code block
    if (line.trim().startsWith('```')) {
      const code = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i++]);
      i++; // closing fence
      blocks.push(
        <pre
          key={key++}
          style={{
            background: 'var(--bg-subtle)',
            border: '1px solid var(--border-color)',
            borderRadius: 'var(--radius-md)',
            padding: '12px 14px',
            overflowX: 'auto',
            fontFamily: 'var(--font-mono)',
            fontSize: '12.5px',
            lineHeight: 1.6
          }}
        >
          {code.join('\n')}
        </pre>
      );
      continue;
    }

    // Headings
    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      const Tag = `h${Math.min(level + 1, 5)}`;
      blocks.push(
        <Tag key={key++} style={{ marginTop: level === 1 ? 0 : '20px', marginBottom: '8px' }}>
          {renderInline(heading[2], `h${key}`)}
        </Tag>
      );
      i++;
      continue;
    }

    // Horizontal rule
    if (/^\s*---+\s*$/.test(line)) {
      blocks.push(<hr key={key++} style={{ margin: '20px 0' }} />);
      i++;
      continue;
    }

    // Block quote
    if (line.trim().startsWith('> ')) {
      const quote = [];
      while (i < lines.length && lines[i].trim().startsWith('> ')) quote.push(lines[i++].trim().slice(2));
      blocks.push(
        <blockquote
          key={key++}
          style={{
            borderLeft: '3px solid var(--primary)',
            paddingLeft: '14px',
            margin: '12px 0',
            color: 'var(--text-secondary)'
          }}
        >
          {renderInline(quote.join(' '), `q${key}`)}
        </blockquote>
      );
      continue;
    }

    // Unordered list
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i++;
      }
      blocks.push(
        <ul key={key++} style={{ paddingLeft: '22px', margin: '10px 0', display: 'grid', gap: '4px' }}>
          {items.map((item, n) => <li key={n}>{renderInline(item, `ul${key}-${n}`)}</li>)}
        </ul>
      );
      continue;
    }

    // Ordered list
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i++;
      }
      blocks.push(
        <ol key={key++} style={{ paddingLeft: '22px', margin: '10px 0', display: 'grid', gap: '4px' }}>
          {items.map((item, n) => <li key={n}>{renderInline(item, `ol${key}-${n}`)}</li>)}
        </ol>
      );
      continue;
    }

    // Blank line
    if (!line.trim()) {
      i++;
      continue;
    }

    // Paragraph: consume until a blank line or a new block starts.
    const para = [];
    while (
      i < lines.length &&
      lines[i].trim() &&
      !/^(#{1,4}\s|\s*[-*]\s|\s*\d+\.\s|>\s|```|\s*---+\s*$)/.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    blocks.push(
      <p key={key++} style={{ margin: '10px 0', lineHeight: 1.7 }}>
        {renderInline(para.join(' '), `p${key}`)}
      </p>
    );
  }

  return <div className="markdown-body">{blocks}</div>;
};

export default Markdown;
