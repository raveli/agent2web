import { card } from './layout.js';
import { esc } from '../../util/html.js';

export function sitePasswordPage(options: {
  title: string;
  action: string;
  next: string;
  error?: string;
}): string {
  return card(
    options.title,
    `<h1>${esc(options.title)}</h1>
<p>This page is password protected.</p>
${options.error ? `<div class="err">${esc(options.error)}</div>` : ''}
<form method="post" action="${esc(options.action)}">
  <input type="hidden" name="next" value="${esc(options.next)}">
  <label for="password">Password</label>
  <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
  <button type="submit">Unlock</button>
</form>`,
  );
}

export function notFoundPage(message = 'This page does not exist.'): string {
  return card('Not found', `<h1>404 — not found</h1><p>${esc(message)}</p>`);
}

export function messagePage(title: string, message: string, extra = ''): string {
  return card(title, `<h1>${esc(title)}</h1><p>${esc(message)}</p>${extra}`);
}
