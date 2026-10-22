/**
 * The Run page's panes: a binary tree of splits whose leaves are terminals or the preview, as
 * in Orca or Windows Terminal. Every function returns a new tree and leaves the old one alone.
 */
export type PaneContent = { kind: 'terminal'; sessionId: string } | { kind: 'preview' };

export type PaneNode =
  | { type: 'leaf'; id: string; content: PaneContent }
  | {
      type: 'split';
      id: string;
      /** 'row' puts `first` on the left; 'column' puts it on top. */
      direction: 'row' | 'column';
      /** Share of the space taken by `first`, between MIN_RATIO and 1 - MIN_RATIO. */
      ratio: number;
      first: PaneNode;
      second: PaneNode;
    };

export type Leaf = Extract<PaneNode, { type: 'leaf' }>;

export const MIN_RATIO = 0.15;

let counter = 0;
const nextId = (prefix: string) =>
  `${prefix}-${Date.now().toString(36)}-${(counter++).toString(36)}`;

export function leaf(content: PaneContent): Leaf {
  return { type: 'leaf', id: nextId('pane'), content };
}

export function leaves(node: PaneNode | null): Leaf[] {
  if (!node) return [];
  return node.type === 'leaf' ? [node] : [...leaves(node.first), ...leaves(node.second)];
}

export function findLeaf(node: PaneNode | null, id: string): Leaf | null {
  return leaves(node).find((item) => item.id === id) ?? null;
}

/** Puts `added` beside the pane `id`: to its right for 'row', under it for 'column'. */
export function splitPane(
  node: PaneNode,
  id: string,
  direction: 'row' | 'column',
  added: Leaf,
): PaneNode {
  if (node.type === 'leaf')
    return node.id === id
      ? { type: 'split', id: nextId('split'), direction, ratio: 0.5, first: node, second: added }
      : node;
  return {
    ...node,
    first: splitPane(node.first, id, direction, added),
    second: splitPane(node.second, id, direction, added),
  };
}

/** Removes the pane `id`; its sibling takes the freed space. Null when it was the last one. */
export function closePane(node: PaneNode, id: string): PaneNode | null {
  if (node.type === 'leaf') return node.id === id ? null : node;
  const first = closePane(node.first, id);
  const second = closePane(node.second, id);
  if (!first) return second;
  if (!second) return first;
  return first === node.first && second === node.second ? node : { ...node, first, second };
}

export function setRatio(node: PaneNode, splitId: string, ratio: number): PaneNode {
  if (node.type === 'leaf') return node;
  if (node.id === splitId)
    return { ...node, ratio: Math.min(1 - MIN_RATIO, Math.max(MIN_RATIO, ratio)) };
  return {
    ...node,
    first: setRatio(node.first, splitId, ratio),
    second: setRatio(node.second, splitId, ratio),
  };
}

export function replaceContent(node: PaneNode, id: string, content: PaneContent): PaneNode {
  if (node.type === 'leaf') return node.id === id ? { ...node, content } : node;
  return {
    ...node,
    first: replaceContent(node.first, id, content),
    second: replaceContent(node.second, id, content),
  };
}
