export interface ChunkOptions {
  /** Upper bound for a chunk, in estimated tokens. */
  maxTokens: number;
  /** Approximate tail of the previous chunk repeated at the start of the next one (same section only). */
  overlapTokens: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = { maxTokens: 200, overlapTokens: 30 };

export interface TextChunk {
  /** Heading path of the section the chunk belongs to, e.g. "Handbook > Refunds". */
  heading: string;
  text: string;
  /** Zero-based index within the document. */
  position: number;
  tokens: number;
}

/** Cheap token estimate (about four characters per token for English prose and code). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

interface Block {
  heading: string;
  text: string;
  fenced: boolean;
}

interface Unit {
  text: string;
  tokens: number;
  /** Separator placed before this unit when it is joined to the previous one. */
  sep: string;
}

const HEADING = /^ {0,3}(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/;
const FENCE = /^ {0,3}(```+|~~~+)/;

/** Splits markdown into paragraph-level blocks tagged with their heading path. Fenced code stays whole. */
function parseBlocks(markdown: string): Block[] {
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  const stack: { level: number; title: string }[] = [];
  let paragraph: string[] = [];
  let fence: { marker: string; lines: string[] } | null = null;

  const path = () => stack.map((h) => h.title).join(" > ");
  const flush = () => {
    const text = paragraph.join("\n").trim();
    if (text) blocks.push({ heading: path(), text, fenced: false });
    paragraph = [];
  };

  for (const line of lines) {
    if (fence) {
      fence.lines.push(line);
      const close = FENCE.exec(line);
      if (close && close[1]!.startsWith(fence.marker[0]!) && close[1]!.length >= fence.marker.length && line.trim() === close[1]) {
        blocks.push({ heading: path(), text: fence.lines.join("\n"), fenced: true });
        fence = null;
      }
      continue;
    }
    const open = FENCE.exec(line);
    if (open) {
      flush();
      fence = { marker: open[1]!, lines: [line] };
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flush();
      const level = heading[1]!.length;
      while (stack.length > 0 && stack[stack.length - 1]!.level >= level) stack.pop();
      stack.push({ level, title: heading[2]!.trim() });
      continue;
    }
    if (line.trim() === "") flush();
    else paragraph.push(line);
  }
  flush();
  if (fence) blocks.push({ heading: path(), text: fence.lines.join("\n"), fenced: true });
  return blocks;
}

function splitWords(text: string, maxTokens: number): string[] {
  const maxChars = Math.max(1, maxTokens * 4);
  const out: string[] = [];
  let current = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (word.length > maxChars) {
      if (current) out.push(current);
      current = "";
      for (let i = 0; i < word.length; i += maxChars) out.push(word.slice(i, i + maxChars));
      continue;
    }
    if (current && current.length + 1 + word.length > maxChars) {
      out.push(current);
      current = word;
    } else {
      current = current ? `${current} ${word}` : word;
    }
  }
  if (current) out.push(current);
  return out;
}

/** Turns a block into units that each fit in `maxTokens`, splitting on lines, sentences, then words. */
function toUnits(block: Block, maxTokens: number): Unit[] {
  const whole = estimateTokens(block.text);
  if (whole <= maxTokens) return [{ text: block.text, tokens: whole, sep: "\n\n" }];

  const pieces = block.fenced ? block.text.split("\n") : block.text.split(/(?<=[.!?])\s+|\n(?=\s*(?:[-*+]|\d+[.)])\s)/);
  const sep = block.fenced ? "\n" : " ";
  const units: Unit[] = [];
  for (const piece of pieces) {
    if (!piece.trim()) continue;
    const tokens = estimateTokens(piece);
    if (tokens <= maxTokens) {
      units.push({ text: piece, tokens, sep });
    } else {
      for (const part of splitWords(piece, maxTokens)) units.push({ text: part, tokens: estimateTokens(part), sep });
    }
  }
  if (units.length > 0) units[0]!.sep = "\n\n";
  return units;
}

/**
 * Markdown-aware chunker.
 *
 * - Chunks never cross a heading; each carries its heading path.
 * - Paragraphs are packed greedily up to `maxTokens`. Oversized paragraphs are split on sentences,
 *   list items and finally words; code fences are split on lines only if they exceed the limit.
 * - When a chunk fills up, trailing units totalling at most `overlapTokens` start the next chunk of
 *   the same section so that context is not cut mid-thought.
 *
 * The output is a pure function of the input, which is what makes re-ingestion idempotent.
 */
export function chunkMarkdown(markdown: string, options: Partial<ChunkOptions> = {}): TextChunk[] {
  const { maxTokens, overlapTokens } = { ...DEFAULT_CHUNK_OPTIONS, ...options };
  if (maxTokens < 1) throw new RangeError("maxTokens must be at least 1");
  if (overlapTokens < 0 || overlapTokens >= maxTokens) throw new RangeError("overlapTokens must be in [0, maxTokens)");

  const sections = new Map<string, Unit[]>();
  for (const block of parseBlocks(markdown)) {
    const list = sections.get(block.heading) ?? [];
    list.push(...toUnits(block, maxTokens));
    sections.set(block.heading, list);
  }

  const chunks: TextChunk[] = [];
  const emit = (heading: string, units: Unit[]) => {
    const text = units.reduce((acc, u, i) => (i === 0 ? u.text : acc + u.sep + u.text), "");
    chunks.push({ heading, text, position: chunks.length, tokens: estimateTokens(text) });
  };

  for (const [heading, units] of sections) {
    let current: Unit[] = [];
    let currentTokens = 0;
    let fresh = 0; // units in `current` that were not carried over as overlap
    for (const unit of units) {
      if (current.length > 0 && currentTokens + unit.tokens > maxTokens) {
        if (fresh > 0) emit(heading, current);
        const carry: Unit[] = [];
        let carried = 0;
        for (let i = current.length - 1; i >= 0; i--) {
          const candidate = current[i]!;
          if (carried + candidate.tokens > overlapTokens) break;
          carry.unshift(candidate);
          carried += candidate.tokens;
        }
        if (carried + unit.tokens > maxTokens) {
          carry.length = 0;
          carried = 0;
        }
        current = carry;
        currentTokens = carried;
        fresh = 0;
      }
      current.push(unit);
      currentTokens += unit.tokens;
      fresh++;
    }
    if (fresh > 0) emit(heading, current);
  }
  return chunks;
}
