import {useMemo, useRef, useState} from 'react';
import type {ReactNode} from 'react';
import {Pencil} from 'lucide-react';
import {createLowlight} from 'lowlight';
import bash from 'highlight.js/lib/languages/bash';
import css from 'highlight.js/lib/languages/css';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import markdown from 'highlight.js/lib/languages/markdown';
import python from 'highlight.js/lib/languages/python';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import 'highlight.js/styles/github.css';

const grammars = {bash, css, javascript, json, markdown, python, rust, sql, typescript, xml, yaml};
const highlighter = createLowlight(grammars);

export type Language = keyof typeof grammars | 'text';

const labels: Record<Language, string> = {
  markdown: 'Markdown', python: 'Python', typescript: 'TypeScript', javascript: 'JavaScript',
  rust: 'Rust', json: 'JSON', bash: 'Shell', css: 'CSS', xml: 'HTML / XML',
  sql: 'SQL', yaml: 'YAML', text: 'Plain text',
};

const extensions: Record<string, Language> = {
  md: 'markdown', mdx: 'markdown', markdown: 'markdown',
  py: 'python', pyi: 'python', ts: 'typescript', tsx: 'typescript',
  mts: 'typescript', cts: 'typescript', js: 'javascript', jsx: 'javascript',
  mjs: 'javascript', cjs: 'javascript', rs: 'rust', json: 'json', jsonc: 'json',
  sh: 'bash', bash: 'bash', zsh: 'bash', css: 'css',
  html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
  sql: 'sql', yaml: 'yaml', yml: 'yaml', txt: 'text',
};

export function languageForPath(path: string): Language {
  const extension = path.split('/').at(-1)?.match(/\.([^.]*)$/)?.[1]?.toLowerCase();
  return extension && Object.hasOwn(extensions, extension) ? extensions[extension] : 'markdown';
}

export function SourceHeader({filename, language, onLanguage, children}: {
  filename: string; language: Language; onLanguage: (language: Language) => void; children?: ReactNode;
}) {
  const [editing, setEditing] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  function closeEditor() {
    setEditing(false);
    requestAnimationFrame(() => trigger.current?.focus());
  }
  return <div className="source-tools">
    <h3>{filename}</h3>
    <div className="source-header-actions">
      {children}
      {editing ? <select autoFocus aria-label="Syntax language" value={language} onBlur={() => setEditing(false)}
        onKeyDown={event => {
          if (event.key === 'Escape') {event.stopPropagation(); closeEditor();}
        }}
        onChange={event => {
          if (isLanguage(event.target.value)) onLanguage(event.target.value);
          closeEditor();
        }}>
        {Object.entries(labels).map(([value, title]) => <option key={value} value={value}>{title}</option>)}
      </select> : <button ref={trigger} type="button" className="syntax-edit"
        aria-label={`Change syntax language, currently ${labels[language]}`} onClick={() => setEditing(true)}>
        {labels[language]} <Pencil size={13} aria-hidden="true"/>
      </button>}
    </div>
  </div>;
}

export function isLanguage(value: string): value is Language {
  return Object.hasOwn(labels, value);
}

type Token = {text: string; classes: string};
export type HighlightedLine = Token[];
type HighlightNode = ReturnType<typeof highlighter.highlight>['children'][number];

export function highlightLines(source: string, language: Language): HighlightedLine[] {
  if (!source) return [];
  const normalized = source.replace(/\r\n/g, '\n');
  const lines: HighlightedLine[] = [[]];

  function append(text: string, classes: string) {
    text.split('\n').forEach((part, index) => {
      if (index) lines.push([]);
      if (part) lines.at(-1)?.push({text: part, classes});
    });
  }

  function visit(node: HighlightNode, inherited: string) {
    if (node.type === 'text') append(node.value, inherited);
    if (node.type === 'element') {
      const classes = node.properties.className;
      const own = Array.isArray(classes) ? classes.join(' ') : '';
      const combined = [inherited, own].filter(Boolean).join(' ');
      node.children.forEach(child => visit(child, combined));
    }
  }

  if (language === 'text') append(normalized, '');
  else highlighter.highlight(language, normalized).children.forEach(node => visit(node, ''));
  if (normalized.endsWith('\n')) lines.pop();
  return lines;
}

export function CodeTokens({line}: {line: HighlightedLine}) {
  return <>{line.map(({text, classes}, index) => classes
    ? <span key={index} className={classes}>{text}</span> : text)}</>;
}

export function CodeExcerpt({lines, className = ''}: {
  lines: HighlightedLine[]; className?: string;
}) {
  return <pre className={`code-block ${className}`}><code className="syntax-code">
    {lines.map((line, index) => <span key={index}>
      <CodeTokens line={line}/>{index < lines.length - 1 ? '\n' : ''}
    </span>)}
  </code></pre>;
}

export function CodeBlock({source, language}: {source: string; language: Language}) {
  const lines = useMemo(() => highlightLines(source, language), [source, language]);
  return <CodeExcerpt lines={lines}/>;
}
