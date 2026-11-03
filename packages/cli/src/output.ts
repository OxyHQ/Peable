/**
 * How the CLI prints an API object: `--json` is the object exactly as the API
 * returned it; otherwise one line per object with the fields a developer
 * scans for. Nothing printed here ever comes from the config file, so a
 * secret cannot reach the terminal through it.
 */

type ApiObject = Record<string, unknown>;

function isObject(value: unknown): value is ApiObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `YYYY-MM-DD HH:MM:SS` in local time — what `listen` and `logs tail` prefix a line with. */
export function timestamp(date: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** One line for one object. */
export function summarize(object: unknown): string {
  if (!isObject(object)) return String(object);
  const parts: string[] = [String(object.id ?? '')];
  const push = (value: unknown) => {
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      parts.push(String(value));
    }
  };
  push(object.type);
  push(object.status);
  if (typeof object.amount === 'string') {
    parts.push(
      `${object.amount}${typeof object.currency === 'string' ? ` ${object.currency}` : ''}`,
    );
  }
  push(object.url);
  if (object.deleted === true) parts.push('deleted');
  if (typeof object.created === 'number') parts.push(timestamp(new Date(object.created * 1000)));
  return parts.filter((part) => part !== '').join('  ');
}

/** Render a single object or a list page. */
export function render(value: unknown, json: boolean): string {
  if (json) return JSON.stringify(value, null, 2);
  if (isObject(value) && value.object === 'list' && Array.isArray(value.data)) {
    if (value.data.length === 0) return '(none)';
    const lines = value.data.map((item) => summarize(item));
    if (value.has_more === true) lines.push('… more: pass --starting-after <last id>');
    return lines.join('\n');
  }
  return summarize(value);
}
