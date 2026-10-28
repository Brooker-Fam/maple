type Layer = { id: string; url: string; close: () => void; locked: () => boolean; pushed: boolean };

const layers: Layer[] = [];
const KEY = "mapleSheet";
const known = new Set<string>();
let listening = false;
let rewinding = false;

function push(layer: Layer) {
  window.history.pushState({ ...window.history.state, [KEY]: layer.id }, "", layer.url);
  layer.pushed = true;
}

function onPop() {
  const id = window.history.state?.[KEY];
  if (rewinding) {
    if (id && !layers.some((layer) => layer.id === id)) {
      window.history.back();
      return;
    }
    rewinding = false;
    for (const layer of layers) if (!layer.pushed) push(layer);
    return;
  }
  const top = layers.at(-1);
  if (!top) {
    if (id && known.has(id)) {
      rewinding = true;
      window.history.back();
    } else if (id) {
      const state = { ...window.history.state };
      delete state[KEY];
      window.history.replaceState(state, "");
    }
    return;
  }
  if (id === top.id) return;
  push(top);
  if (!top.locked()) top.close();
}

export function registerSheet(close: () => void, locked: () => boolean): () => void {
  if (!listening) {
    window.addEventListener("popstate", onPop, true);
    listening = true;
  }
  const layer: Layer = { id: window.crypto.randomUUID(), url: window.location.href, close, locked, pushed: false };
  known.add(layer.id);
  layers.push(layer);
  if (!rewinding) push(layer);
  return () => {
    const index = layers.indexOf(layer);
    if (index >= 0) layers.splice(index, 1);
    if (window.history.state?.[KEY] === layer.id && !rewinding) {
      rewinding = true;
      window.history.back();
    }
  };
}
