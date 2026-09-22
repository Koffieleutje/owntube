/** The ids with `id` moved one place up (-1) or down (+1); null at an end. */
export function moveId(
  ids: string[],
  id: string,
  delta: -1 | 1,
): string[] | null {
  const from = ids.indexOf(id);
  const to = from + delta;
  if (from < 0 || to < 0 || to >= ids.length) return null;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}
