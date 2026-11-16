/** Turns a title into a URL slug: lowercase words joined by dashes. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Capitalizes the first letter of each word. */
export function titleCase(text: string): string {
  return text
    .toLowerCase()
    .split(' ')
    .map((word) => (word ? word[0]!.toUpperCase() + word.slice(1) : word))
    .join(' ');
}

/** Shortens text to at most `maxLength` characters, ending with "…" and not cutting words. */
export function truncateWords(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  const room = maxLength - 1;
  const cut = text.slice(0, room + 1);
  const space = cut.lastIndexOf(' ');
  const head = space > 0 ? text.slice(0, space).trimEnd() : text.slice(0, room);
  return `${head}…`;
}
