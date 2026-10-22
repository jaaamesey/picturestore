import type { Layer, LayerContent } from "./document";

/**
 * The layer tree. A document's layers, and each group's, are stored bottom
 * to top; groups nest. These are pure functions over layer arrays that
 * share whatever they don't change.
 */

export type GroupContent = Extract<LayerContent, { kind: "group" }>;
export type GroupLayer = Layer & { readonly content: GroupContent };

export const isGroup = (l: Layer): l is GroupLayer => l.content.kind === "group";
export const isAdjustment = (l: Layer) => l.content.kind === "adjustment";
/** Whether a layer holds pixels of its own (pixel layers, smart objects, shapes). */
export const hasPixels = (l: Layer) => l.content.kind !== "group" && l.content.kind !== "adjustment";

export const childrenOf = (l: Layer): readonly Layer[] => (isGroup(l) ? l.content.layers : []);
const withChildren = (g: Layer, layers: readonly Layer[]): Layer => ({ ...g, content: { ...(g.content as GroupContent), layers } });

/** Where a layer sits: its container's layers, its index there, and the group containing it (null at the top level). */
export interface Place {
  readonly siblings: readonly Layer[];
  readonly index: number;
  readonly parent: GroupLayer | null;
}

/** The tree's shape: ids, nested as groups nest. */
export const treeShape = (layers: readonly Layer[]): string => layers.map((l) => (isGroup(l) ? `${l.id}[${treeShape(l.content.layers)}]` : l.id)).join(",");

/** Every layer, depth first: a group comes before its contents, each container bottom to top. */
export function* walk(layers: readonly Layer[]): Generator<Layer> {
  for (const l of layers) {
    yield l;
    if (isGroup(l)) yield* walk(l.content.layers);
  }
}

export const allLayers = (layers: readonly Layer[]): Layer[] => [...walk(layers)];

export function findLayer(layers: readonly Layer[], id: string): Layer | undefined {
  for (const l of walk(layers)) if (l.id === id) return l;
}

export function locate(layers: readonly Layer[], id: string, parent: GroupLayer | null = null): Place | null {
  for (let index = 0; index < layers.length; index++) {
    const l = layers[index];
    if (l.id === id) return { siblings: layers, index, parent };
    if (isGroup(l)) {
      const p = locate(l.content.layers, id, l);
      if (p) return p;
    }
  }
  return null;
}

/** The groups containing a layer, outermost first. */
export function ancestors(layers: readonly Layer[], id: string): GroupLayer[] {
  const out: GroupLayer[] = [];
  for (let p = locate(layers, id); p?.parent; p = locate(layers, p.parent.id)) out.unshift(p.parent);
  return out;
}

/** Whether `id` is `ancestorId` or inside it. */
export const isWithin = (layers: readonly Layer[], id: string, ancestorId: string) =>
  id === ancestorId || ancestors(layers, id).some((g) => g.id === ancestorId);

/** Maps every layer (bottom-up: a group's contents are mapped before it), keeping untouched branches. */
export function mapLayers(layers: readonly Layer[], f: (l: Layer) => Layer): readonly Layer[] {
  let changed = false;
  const out = layers.map((l) => {
    let n = l;
    if (isGroup(l)) {
      const kids = mapLayers(l.content.layers, f);
      if (kids !== l.content.layers) n = withChildren(l, kids);
    }
    n = f(n);
    if (n !== l) changed = true;
    return n;
  });
  return changed ? out : layers;
}

/** Replaces the layer with `id` by `f(layer)`. */
export const updateIn = (layers: readonly Layer[], id: string, f: (l: Layer) => Layer) => mapLayers(layers, (l) => (l.id === id ? f(l) : l));

/** Applies `f` to the container (top level or group contents) holding `id`. */
function inContainerOf(layers: readonly Layer[], id: string, f: (siblings: readonly Layer[]) => readonly Layer[]): readonly Layer[] {
  const p = locate(layers, id);
  if (!p) return layers;
  return p.parent ? updateIn(layers, p.parent.id, (g) => withChildren(g, f(childrenOf(g)))) : f(layers);
}

/** Takes the layer with `id` (and its contents) out of the tree. */
export function removeFrom(layers: readonly Layer[], id: string): readonly Layer[] {
  return inContainerOf(layers, id, (s) => s.filter((l) => l.id !== id));
}

/** Where to put a layer relative to a target: next to it, or inside it (a group) at the top or the bottom. */
export type Placement = "above" | "below" | "inside" | "inside-bottom";

/** Inserts `layer` relative to `targetId` (at the top of the document if there's no such target). */
export function insertAt(layers: readonly Layer[], layer: Layer, targetId: string | null, placement: Placement): readonly Layer[] {
  const target = targetId === null ? undefined : findLayer(layers, targetId);
  if (!target) return [...layers, layer];
  if (placement === "inside" && isGroup(target)) return updateIn(layers, target.id, (g) => withChildren(g, [...childrenOf(g), layer]));
  if (placement === "inside-bottom" && isGroup(target)) return updateIn(layers, target.id, (g) => withChildren(g, [layer, ...childrenOf(g)]));
  return inContainerOf(layers, target.id, (s) => {
    const i = s.findIndex((l) => l.id === target.id) + (placement === "below" ? 0 : 1);
    return [...s.slice(0, i), layer, ...s.slice(i)];
  });
}

/**
 * Whether the layer at `index` is clipped: it's marked so and has a layer
 * below it in the same container (the bottom layer of a group or of the
 * document can't be).
 */
export const isClipped = (siblings: readonly Layer[], index: number) => index > 0 && siblings[index].clipped;

/** The index of the base layer a (possibly clipped) layer clips to. */
export function clipBaseIndex(siblings: readonly Layer[], index: number): number {
  while (isClipped(siblings, index)) index--;
  return index;
}

/** Whether a layer is visible in the image: it and its groups are shown, and so is its clipping base. */
export function isShown(layers: readonly Layer[], id: string): boolean {
  const p = locate(layers, id);
  if (!p) return false;
  const l = p.siblings[p.index];
  const base = p.siblings[clipBaseIndex(p.siblings, p.index)];
  return l.visible && base.visible && (!p.parent || isShown(layers, p.parent.id));
}
