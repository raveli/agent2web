const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escapes a value for interpolation into HTML text or a quoted attribute value.
 *
 * NOT sufficient for JavaScript contexts such as an `onclick` attribute or a
 * `<script>` body: the HTML parser decodes entities before the JS parser sees
 * them, so `&#39;` turns back into an apostrophe and closes a string literal.
 * Pass values to JS through a `data-` attribute and read them via `dataset`.
 */
export function esc(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, ch => ESCAPES[ch]!);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value < 10 ? 1 : 0)} ${units[unit]}`;
}

export function formatDate(epochMs: number): string {
  return new Date(epochMs).toISOString().replace('T', ' ').slice(0, 16) + 'Z';
}
