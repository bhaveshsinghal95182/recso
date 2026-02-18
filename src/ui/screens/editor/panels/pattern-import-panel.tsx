import React, { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { useProjectStore } from '@/store/project-store';

import type { BackgroundPatternConfig } from '../../../../shared/patterns';

type ParseResult = {
  style: React.CSSProperties | null;
  backgroundColor: string | null;
  error?: string;
};

const EXAMPLE_SNIPPET = `<div className="min-h-screen w-full bg-black relative">\n  <div\n    className="absolute inset-0 z-0"\n    style={{\n      backgroundImage: \`\n        radial-gradient(circle at 50% 100%, rgba(255, 69, 0, 0.6) 0%, transparent 60%),\n        radial-gradient(circle at 50% 100%, rgba(255, 140, 0, 0.4) 0%, transparent 70%),\n        radial-gradient(circle at 50% 100%, rgba(255, 215, 0, 0.3) 0%, transparent 80%)\n      \`,\n    }}\n  />\n</div>`;

function parseSnippet(snippet: string): ParseResult {
  const styleText = extractInlineStyle(snippet);
  if (!styleText) {
    return { style: null, backgroundColor: null, error: 'No inline style found.' };
  }

  const style = parseStyleObject(styleText);
  if (!style || Object.keys(style).length === 0) {
    return { style: null, backgroundColor: null, error: 'Unable to parse style block.' };
  }

  const className = extractOuterClassName(snippet);
  const backgroundColor = parseBackgroundColorFromClassName(className);

  return { style, backgroundColor };
}

function extractOuterClassName(snippet: string): string | null {
  const classNameMatch = snippet.match(/<div[^>]*\bclassName\s*=\s*["']([^"']+)["']/);
  if (classNameMatch) return classNameMatch[1];

  const classMatch = snippet.match(/<div[^>]*\bclass\s*=\s*["']([^"']+)["']/);
  if (classMatch) return classMatch[1];

  return null;
}

function extractInlineStyle(snippet: string): string | null {
  const matches = [...snippet.matchAll(/style\s*=\s*\{\{([\s\S]*?)\}\}/g)];
  if (matches.length === 0) return null;
  return matches[matches.length - 1][1];
}

function parseBackgroundColorFromClassName(className: string | null): string | null {
  if (!className) return null;
  if (className.includes('bg-transparent')) return 'transparent';
  if (className.includes('bg-black')) return '#000000';
  if (className.includes('bg-white')) return '#ffffff';

  const bracketMatch = className.match(/bg-\[([^\]]+)\]/);
  if (bracketMatch) return bracketMatch[1];

  return null;
}

function parseStyleObject(styleText: string): React.CSSProperties {
  const segments = splitTopLevel(styleText, ',');
  const style: React.CSSProperties = {};

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;
    const { key, value } = splitKeyValue(trimmed);
    if (!key || value === null) continue;

    const normalized = normalizeValue(value);
    if (normalized.length === 0) continue;

    style[key as keyof React.CSSProperties] = normalized as never;
  }

  return style;
}

function splitTopLevel(input: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let quote: string | null = null;
  let escape = false;

  for (let i = 0; i < input.length; i += 1) {
    const char = input[i];

    if (escape) {
      current += char;
      escape = false;
      continue;
    }

    if (quote) {
      if (char === '\\') {
        current += char;
        escape = true;
        continue;
      }

      current += char;
      if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      current += char;
      continue;
    }

    if (char === delimiter) {
      result.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  if (current.trim().length > 0) {
    result.push(current);
  }

  return result;
}

function splitKeyValue(segment: string): { key: string | null; value: string | null } {
  let quote: string | null = null;
  let escape = false;

  for (let i = 0; i < segment.length; i += 1) {
    const char = segment[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (quote) {
      if (char === '\\') {
        escape = true;
      } else if (char === quote) {
        quote = null;
      }
      continue;
    }

    if (char === "'" || char === '"' || char === '`') {
      quote = char;
      continue;
    }

    if (char === ':') {
      const key = segment.slice(0, i).trim();
      const value = segment.slice(i + 1).trim();
      return { key, value };
    }
  }

  return { key: null, value: null };
}

function normalizeValue(value: string): string {
  let normalized = value.trim();
  if (normalized.endsWith(',')) normalized = normalized.slice(0, -1).trim();
  if (normalized.endsWith(';')) normalized = normalized.slice(0, -1).trim();

  const wrappers: Array<[string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ['`', '`'],
  ];

  for (const [start, end] of wrappers) {
    if (normalized.startsWith(start) && normalized.endsWith(end)) {
      normalized = normalized.slice(1, -1);
      break;
    }
  }

  return normalized;
}

export function PatternImportPanel() {
  const { project, updateBackgroundColor, updateBackgroundPattern } = useProjectStore();
  const [snippet, setSnippet] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [detectedColor, setDetectedColor] = useState<string | null>(null);

  const canApply = useMemo(() => snippet.trim().length > 0, [snippet]);

  if (!project) return null;

  const handleApply = () => {
    const parsed = parseSnippet(snippet);
    if (!parsed.style) {
      setError(parsed.error || 'Unable to parse snippet.');
      setDetectedColor(null);
      return;
    }

    const pattern: BackgroundPatternConfig = {
      id: 'custom-import',
      label: 'Custom',
      style: parsed.style,
      containerStyle: {},
    };

    updateBackgroundPattern(pattern);

    if (parsed.backgroundColor) {
      updateBackgroundColor(parsed.backgroundColor);
      setDetectedColor(parsed.backgroundColor);
    } else {
      setDetectedColor(null);
    }

    setError(null);
  };

  const handleUseExample = () => {
    setSnippet(EXAMPLE_SNIPPET);
    setError(null);
  };

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="pattern-snippet">Paste JSX pattern snippet</Label>
        <textarea
          id="pattern-snippet"
          value={snippet}
          onChange={(event) => setSnippet(event.target.value)}
          placeholder={EXAMPLE_SNIPPET}
          className="min-h-[180px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs font-mono text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
        />
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={handleApply} disabled={!canApply}>
          Apply Pattern
        </Button>
        <Button variant="outline" onClick={handleUseExample}>
          Use Example
        </Button>
      </div>

      {detectedColor && (
        <div className="text-xs text-muted-foreground">
          Detected background color: <span className="font-mono">{detectedColor}</span>
        </div>
      )}

      {error && <div className="text-xs text-destructive">{error}</div>}
    </div>
  );
}
