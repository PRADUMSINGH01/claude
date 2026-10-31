// Scene file templates written by code: the skeleton the scene writer fills in, and the fallback that
// guarantees a working film when a scene can't be written. Both follow the sub-composition contract
// (hyperframes references/format.md#shape-of-a-project): everything inside <template>, #root carries the
// composition id, styles target #root, one paused timeline registered under the same id.

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function skeleton(id) {
  return `<template>
  <style>
    #root { position: absolute; inset: 0; container-type: size; font-family: var(--font-display); color: var(--fg); }
    /* scene styles: target #root and ids prefixed "${id}-" */
  </style>
  <div id="root" data-composition-id="${id}">
    <!-- timed elements: class="clip" data-start data-duration (seconds, scene-relative), stable ids "${id}-…" -->
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
    // tweens: fromTo only; animate children of .clip elements; positions in seconds from the scene start
    window.__timelines["${id}"] = tl;
  </script>
</template>
`;
}

// A plain, correct reveal of the scene's copy: each word blurs in where it sits (motion.md#motion-craft:
// blur 6px → 0 and opacity 0 → 1 in 0.13 s, 0.067 s apart, no translate), then holds still. Used before the writer
// runs and whenever its output can't be made to pass the checks. A companion (extra copy over a block)
// sits in the lower part of the frame so it never lands on the block's own text.
export function fallbackScene(scene, format, roles) {
  const id = scene.id;
  const lines = (scene.text ?? []).filter((t) => String(t).trim());
  const d = Number(scene.duration) || 3;
  const words = lines.join(' ').split(/\s+/).filter(Boolean).length || 1;
  // Size from the box: the longest line must fit; fewer words, bigger type.
  const longest = Math.max(1, ...lines.map((l) => l.length));
  const size = Math.max(3, Math.min(14, 160 / longest, 40 / Math.sqrt(words)));
  // Every word must have landed by a third of the scene, so the rest is a readable hold.
  const gap = Math.max(0.02, Math.min(0.067, (d / 3 - 0.28) / Math.max(1, words - 1)));
  let n = 0;
  const items = lines.map((line, i) => ({ id: `${id}-line-${i + 1}`, line, words: line.split(/\s+/).filter(Boolean).map((w) => ({ w, at: +(0.15 + gap * n++).toFixed(3) })) }));
  return `<template>
  <style>
    #root { position: absolute; inset: 0; container-type: size; display: flex; flex-direction: column; align-items: center; justify-content: ${scene.companionOf ? 'flex-end' : 'center'}; gap: 2cqh; font-family: var(--font-display); color: var(--fg); text-align: center; padding: 0 6cqw${scene.companionOf ? ' 16cqh' : ''}; }
    #root .${id}-line { font-size: ${size.toFixed(2)}cqmin; line-height: 1.1; font-weight: 700; max-width: 100%; }
    #root .${id}-line:nth-child(n + 2) { font-size: ${Math.max(2.8, size * 0.55).toFixed(2)}cqmin; font-weight: 400; opacity: 0.85; }
    #root .${id}-w { display: inline-block; }
  </style>
  <div id="root" data-composition-id="${id}">
${items.map((x) => `    <div id="${x.id}" class="clip ${id}-line" data-start="0" data-duration="${d}">${x.words.map((w, j) => `<span id="${x.id}-w${j + 1}" class="${id}-w">${esc(w.w)}</span>`).join(' ')}</div>`).join('\n')}
  </div>
  <script>
    const tl = gsap.timeline({ paused: true });
${items.flatMap((x) => x.words.map((w, j) => `    tl.fromTo("#${x.id}-w${j + 1}", { opacity: 0, filter: "blur(6px)" }, { opacity: 1, filter: "blur(0px)", duration: 0.13, ease: "power2.out" }, ${w.at});`)).join('\n')}
    window.__timelines["${id}"] = tl;
  </script>
</template>
`;
}
