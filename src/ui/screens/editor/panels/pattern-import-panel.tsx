import { Info } from 'lucide-react';
import React, { useMemo, useState } from 'react';

import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useProjectStore } from '@/store/project-store';

import type { BackgroundPatternConfig } from '../../../../shared/patterns';

type ExtractedBackgroundStyle = Partial<
  Pick<
    React.CSSProperties,
    | 'background'
    | 'backgroundImage'
    | 'backgroundSize'
    | 'backgroundPosition'
    | 'backgroundRepeat'
    | 'backgroundBlendMode'
  >
>;

type BackgroundStyleKey = keyof ExtractedBackgroundStyle;

type ParseResult = {
  style: ExtractedBackgroundStyle | null;
  extractedKeys: BackgroundStyleKey[];
  backgroundColor: string | null;
  error?: string;
};

const STYLE_PROP_MAP: Record<string, BackgroundStyleKey> = {
  background: 'background',
  backgroundimage: 'backgroundImage',
  'background-image': 'backgroundImage',
  backgroundsize: 'backgroundSize',
  'background-size': 'backgroundSize',
  backgroundposition: 'backgroundPosition',
  'background-position': 'backgroundPosition',
  backgroundrepeat: 'backgroundRepeat',
  'background-repeat': 'backgroundRepeat',
  backgroundblendmode: 'backgroundBlendMode',
  'background-blend-mode': 'backgroundBlendMode',
};

const EXAMPLE_SNIPPETS = [
  `<div className="min-h-screen w-full bg-black relative">
  <div
    className="absolute inset-0 z-0"
    style={{
      backgroundImage: \
        \`radial-gradient(circle at 50% 100%, rgba(255, 69, 0, 0.6) 0%, transparent 60%),
        radial-gradient(circle at 50% 100%, rgba(255, 140, 0, 0.4) 0%, transparent 70%),
        radial-gradient(circle at 50% 100%, rgba(255, 215, 0, 0.3) 0%, transparent 80%)\`,
      backgroundRepeat: 'no-repeat',
      backgroundSize: 'cover',
      backgroundPosition: 'center',
    }}
  />
</div>`,
  `<div className="min-h-screen w-full bg-[#0b0b12]">
  <div
    style={{
      background: \
        \`linear-gradient(180deg, rgba(247,234,255,1) 0%, rgba(253,226,234,1) 100%)\`,
      backgroundBlendMode: 'screen',
    }}
  />
</div>`,
  `<div style="background-image: radial-gradient(circle at 50% 100%, rgba(255, 69, 0, 0.6) 0%, transparent 60%), radial-gradient(circle at 50% 100%, rgba(255, 140, 0, 0.4) 0%, transparent 70%), radial-gradient(circle at 50% 100%, rgba(255, 215, 0, 0.3) 0%, transparent 80%); background-repeat: no-repeat; background-size: cover; background-position: center;"></div>`,
];

function parseSnippet(snippet: string): ParseResult {
  const payload = extractInlineStylePayload(snippet);

  let style: ExtractedBackgroundStyle = {};
  if (payload) {
    style =
      payload.syntax === 'jsx'
        ? extractFromJsStyleObject(payload.text)
        : extractFromCssDeclarations(payload.text);
  } else {
    // Fallback for raw style snippets without style= wrapper.
    style = extractFromJsStyleObject(snippet);
    if (Object.keys(style).length === 0) {
      style = extractFromCssDeclarations(snippet);
    }
  }

  if (!style || Object.keys(style).length === 0) {
    return {
      style: null,
      extractedKeys: [],
      backgroundColor: null,
      error: 'No supported background style properties found.',
    };
  }

  const className = extractOuterClassName(snippet);
  const backgroundColor = parseBackgroundColorFromClassName(className);
  const extractedKeys = Object.keys(style) as BackgroundStyleKey[];

  return { style, extractedKeys, backgroundColor };
}

function extractOuterClassName(snippet: string): string | null {
  const classNameMatch = snippet.match(/<div[^>]*\bclassName\s*=\s*["']([^"']+)["']/);
  if (classNameMatch) return classNameMatch[1];

  const classMatch = snippet.match(/<div[^>]*\bclass\s*=\s*["']([^"']+)["']/);
  if (classMatch) return classMatch[1];

  return null;
}

function extractInlineStylePayload(
  snippet: string,
): { syntax: 'jsx' | 'css'; text: string } | null {
  const jsxMatches = [...snippet.matchAll(/style\s*=\s*\{\{([\s\S]*?)\}\}/g)];
  if (jsxMatches.length > 0) {
    return { syntax: 'jsx', text: jsxMatches[jsxMatches.length - 1][1] };
  }

  const htmlMatches = [...snippet.matchAll(/style\s*=\s*(["'])([\s\S]*?)\1/g)];
  if (htmlMatches.length > 0) {
    return { syntax: 'css', text: htmlMatches[htmlMatches.length - 1][2] };
  }

  return null;
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

function extractFromJsStyleObject(styleText: string): ExtractedBackgroundStyle {
  const segments = splitTopLevel(styleText, ',');
  const style: ExtractedBackgroundStyle = {};

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    const { key, value } = splitKeyValue(trimmed);
    if (!key || value === null) continue;

    const styleKey = normalizeStyleKey(key);
    if (!styleKey) continue;

    const normalized = normalizeValue(value);
    if (normalized.length === 0) continue;

    style[styleKey] = normalized as never;
  }

  return style;
}

function extractFromCssDeclarations(styleText: string): ExtractedBackgroundStyle {
  const segments = splitTopLevel(styleText, ';');
  const style: ExtractedBackgroundStyle = {};

  for (const segment of segments) {
    const trimmed = segment.trim();
    if (!trimmed) continue;

    const { key, value } = splitKeyValue(trimmed);
    if (!key || value === null) continue;

    const styleKey = normalizeStyleKey(key);
    if (!styleKey) continue;

    const normalized = normalizeValue(value);
    if (normalized.length === 0) continue;

    style[styleKey] = normalized as never;
  }

  return style;
}

function splitTopLevel(input: string, delimiter: string): string[] {
  const result: string[] = [];
  let current = '';
  let quote: string | null = null;
  let escape = false;
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;

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

    if (char === '(') {
      parenDepth += 1;
      current += char;
      continue;
    }

    if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      current += char;
      continue;
    }

    if (char === '{') {
      braceDepth += 1;
      current += char;
      continue;
    }

    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      current += char;
      continue;
    }

    if (char === '[') {
      bracketDepth += 1;
      current += char;
      continue;
    }

    if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      current += char;
      continue;
    }

    if (char === delimiter && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
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
  let parenDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;

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

    if (char === '(') {
      parenDepth += 1;
      continue;
    }

    if (char === ')') {
      parenDepth = Math.max(0, parenDepth - 1);
      continue;
    }

    if (char === '{') {
      braceDepth += 1;
      continue;
    }

    if (char === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      continue;
    }

    if (char === '[') {
      bracketDepth += 1;
      continue;
    }

    if (char === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
      continue;
    }

    if (char === ':' && parenDepth === 0 && braceDepth === 0 && bracketDepth === 0) {
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

function normalizeStyleKey(rawKey: string): BackgroundStyleKey | null {
  const stripped = rawKey.trim().replace(/^['"`]|['"`]$/g, '');
  const lowered = stripped.toLowerCase();
  return STYLE_PROP_MAP[lowered] ?? null;
}

export function PatternImportPanel() {
  const { project, updateBackgroundColor, updateBackgroundPattern, updateBackgroundMode } =
    useProjectStore();
  const [snippet, setSnippet] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [detectedColor, setDetectedColor] = useState<string | null>(null);
  const [exampleIndex, setExampleIndex] = useState(-1);

  const canApply = useMemo(() => snippet.trim().length > 0, [snippet]);
  const parsedPreview = useMemo(
    () => (snippet.trim().length > 0 ? parseSnippet(snippet) : null),
    [snippet],
  );

  if (!project) return null;

  const handleApply = () => {
    const parsed = parseSnippet(snippet);
    if (!parsed.style) {
      setError(parsed.error || 'Unable to parse snippet.');
      setDetectedColor(null);
      return;
    }

    const now = Date.now();
    const pattern: BackgroundPatternConfig = {
      id: `custom-import-${now}`,
      label: 'Custom',
      style: parsed.style,
      containerStyle: {},
    };

    updateBackgroundPattern(pattern);
    updateBackgroundMode('pattern');

    if (parsed.backgroundColor) {
      updateBackgroundColor(parsed.backgroundColor);
      setDetectedColor(parsed.backgroundColor);
    } else {
      setDetectedColor(null);
    }

    setError(null);
  };

  const handleTryExample = () => {
    setExampleIndex((current) => {
      const next = (current + 1) % EXAMPLE_SNIPPETS.length;
      setSnippet(EXAMPLE_SNIPPETS[next]);
      return next;
    });
    setError(null);
  };

  const previewStyle = useMemo<React.CSSProperties>(() => {
    const baseColor = parsedPreview?.backgroundColor ?? project.backgroundColor ?? '#000000';
    return {
      backgroundColor: baseColor,
      ...(parsedPreview?.style || {}),
    };
  }, [parsedPreview, project.backgroundColor]);

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <textarea
          id="pattern-snippet"
          value={snippet}
          onChange={(event) => setSnippet(event.target.value)}
          placeholder={EXAMPLE_SNIPPETS[0]}
          className="min-h-45 w-full rounded-md border border-input bg-transparent px-3 py-2 text-xs font-mono text-foreground shadow-xs outline-none focus-visible:border-ring focus-visible:ring-ring/50 focus-visible:ring-[3px]"
        />
      </div>

      <div className="flex items-center gap-2">
        <Button onClick={handleApply} disabled={!canApply}>
          Apply Pattern
        </Button>

        <Button variant="outline" onClick={handleTryExample}>
          Try example
        </Button>

        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-border bg-background text-muted-foreground transition hover:text-foreground"
                aria-label="Pattern attribution info"
              >
                <Info className="h-4 w-4" />
              </button>
            </TooltipTrigger>

            <TooltipContent className="max-w-xs">
              <p>
                Patterns can be discovered via{' '}
                <a
                  href="https://patterncraft.fun"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="underline underline-offset-2"
                >
                  patterncraft.fun
                </a>
                . This is an independent project and not affiliated with Recso. If you find it
                useful, consider supporting the creator.
              </p>
            </TooltipContent>
          </Tooltip>
        </TooltipProvider>
      </div>

      {exampleIndex >= 0 && (
        <div className="text-xs text-muted-foreground">
          Example {exampleIndex + 1} of {EXAMPLE_SNIPPETS.length}
        </div>
      )}

      {parsedPreview?.style && (
        <div className="space-y-2">
          <Label>Parsed Preview</Label>
          <div className="h-28 w-full rounded-md border border-border" style={previewStyle} />
          <div className="text-xs text-muted-foreground">
            Extracted properties: {parsedPreview.extractedKeys.join(', ')}
          </div>
        </div>
      )}

      {detectedColor && (
        <div className="text-xs text-muted-foreground">
          Detected background color: <span className="font-mono">{detectedColor}</span>
        </div>
      )}

      {error && <div className="text-xs text-destructive">{error}</div>}
    </div>
  );
}
