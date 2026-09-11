import { DIAGNOSTICS } from './config'

/**
 * Two helpers, not a logging framework.
 *
 * Categories keep the console readable when the mic, the socket, the audio
 * queue and the display are all talking at once. Nothing in the app's
 * behaviour may depend on these being called.
 */
export type LogCategory = 'G2' | 'Gemini' | 'Audio' | 'Display' | 'Session' | 'Network' | 'Startup'

export function log(category: LogCategory, message: string, ...rest: unknown[]): void {
  if (!DIAGNOSTICS.verbose) return
  console.log(`[${category}] ${message}`, ...rest)
}

export function warn(category: LogCategory, message: string, ...rest: unknown[]): void {
  console.warn(`[${category}] ${message}`, ...rest)
}

export function error(category: LogCategory, message: string, ...rest: unknown[]): void {
  console.error(`[${category}] ${message}`, ...rest)
}
