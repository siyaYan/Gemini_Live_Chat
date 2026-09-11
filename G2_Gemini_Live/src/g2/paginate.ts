import { DISPLAY } from '../config'

/**
 * Page splitting for the G2 text container.
 *
 * Same shape and algorithm as the official `text-heavy` template: paragraph
 * aware, splits oversized paragraphs at whitespace, never mid-word, lines
 * costed against the container height at a fixed 27 px LVGL line height.
 *
 * One difference. The template measures with `@evenrealities/pretext`, which
 * gives pixel-accurate glyph advances matching the firmware. That package is
 * not installed here, so `measureLines` below estimates from an average glyph
 * width. The estimator is injectable precisely so pretext can replace it later
 * without touching the paging logic:
 *
 *   import { measureTextWrap } from '@evenrealities/pretext'
 *   paginate(text, box, (t, w) => measureTextWrap(t, w).lineCount)
 *
 * The estimate is deliberately conservative — a slightly under-filled page is
 * harmless, a clipped one loses words.
 */

export interface PaginateBox {
  width: number
  height: number
}

export type LineMeasurer = (text: string, width: number) => number

export function paginate(source: string, box: PaginateBox, measure: LineMeasurer = measureLines): string[] {
  const maxLines = Math.max(1, Math.floor(box.height / DISPLAY.lineHeightPx))
  const paragraphs = source
    .split(/\n{2,}/)
    .map(paragraph => paragraph.trim())
    .filter(Boolean)

  if (!paragraphs.length) return []

  const pages: string[] = []
  let buffer: string[] = []
  let bufferLines = 0

  const flush = () => {
    if (!buffer.length) return
    pages.push(buffer.join('\n\n'))
    buffer = []
    bufferLines = 0
  }

  for (const paragraph of paragraphs) {
    const paragraphLines = measure(paragraph, box.width)

    if (paragraphLines > maxLines) {
      flush()
      for (const chunk of splitParagraph(paragraph, box.width, maxLines, measure)) {
        pages.push(chunk)
      }
      continue
    }

    // +1 line for the blank between two paragraphs sharing a page.
    const cost = paragraphLines + (buffer.length ? 1 : 0)
    if (bufferLines + cost > maxLines) {
      flush()
      buffer.push(paragraph)
      bufferLines = paragraphLines
    } else {
      buffer.push(paragraph)
      bufferLines += cost
    }
  }

  flush()
  return pages
}

function splitParagraph(text: string, width: number, maxLines: number, measure: LineMeasurer): string[] {
  const tokens = text.split(/(\s+)/)
  const chunks: string[] = []
  let current = ''

  for (const token of tokens) {
    const candidate = current + token
    if (measure(candidate, width) > maxLines && current.trim()) {
      chunks.push(current.trim())
      current = token.replace(/^\s+/, '')
    } else {
      current = candidate
    }
  }

  if (current.trim()) chunks.push(current.trim())
  return chunks
}

/**
 * Greedy word wrap against an average glyph advance.
 *
 * CJK characters are roughly twice as wide as Latin ones and wrap per
 * character rather than per word, which matters because this assistant is
 * explicitly bilingual — measuring a Chinese answer with a Latin advance would
 * badly under-count lines and clip the page.
 */
export function measureLines(text: string, width: number): number {
  if (!text) return 1

  const maxWidth = Math.max(1, width)
  let lines = 1
  let used = 0

  for (const segment of segments(text)) {
    if (segment === '\n') {
      lines += 1
      used = 0
      continue
    }

    const segmentWidth = widthOf(segment)

    if (used > 0 && used + segmentWidth > maxWidth) {
      lines += 1
      used = segmentWidth
      continue
    }

    used += segmentWidth
  }

  return lines
}

/** Words keep their trailing space; CJK breaks anywhere, so each char stands alone. */
function segments(text: string): string[] {
  const out: string[] = []
  let word = ''

  const pushWord = () => {
    if (!word) return
    out.push(word)
    word = ''
  }

  for (const char of text) {
    if (char === '\n') {
      pushWord()
      out.push('\n')
      continue
    }

    if (isWide(char)) {
      pushWord()
      out.push(char)
      continue
    }

    word += char

    if (char === ' ') {
      pushWord()
    }
  }

  pushWord()
  return out
}

function widthOf(segment: string): number {
  let width = 0
  for (const char of segment) {
    width += isWide(char) ? DISPLAY.averageCharWidthPx * 2 : DISPLAY.averageCharWidthPx
  }
  return width
}

function isWide(char: string): boolean {
  const code = char.codePointAt(0) ?? 0
  return (
    (code >= 0x1100 && code <= 0x115f) || // Hangul Jamo
    (code >= 0x2e80 && code <= 0xa4cf) || // CJK radicals .. Yi
    (code >= 0xac00 && code <= 0xd7a3) || // Hangul syllables
    (code >= 0xf900 && code <= 0xfaff) || // CJK compatibility ideographs
    (code >= 0xfe30 && code <= 0xfe4f) || // CJK compatibility forms
    (code >= 0xff00 && code <= 0xff60) || // Fullwidth forms
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x20000 && code <= 0x3fffd) // CJK extension planes
  )
}
