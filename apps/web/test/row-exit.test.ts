// @vitest-environment jsdom
/**
 * row-exit: a row taken out of a list on the page leaves a "ghost" copy in its
 * place that collapses and then goes. jsdom has no Web Animations API, so
 * `Element.prototype.animate` is stubbed here; finishing an animation is
 * calling the stub's `onfinish`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ROW_EXIT_MS, watchRowExits } from '../src/row-exit';

interface FakeAnim {
  onfinish: (() => void) | null;
  oncancel: (() => void) | null;
}

let anims: { el: Element; frames: Keyframe[]; opts: KeyframeAnimationOptions; anim: FakeAnim }[] = [];
let stop: () => void = () => {};
const realAnimate = Element.prototype.animate;

/** MutationObserver callbacks run as a microtask. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function page(): { root: HTMLElement; list: HTMLUListElement } {
  document.body.innerHTML = `
    <div id="page">
      <ul class="px-rows" data-testid="list">
        <li class="px-trow" data-testid="row-a"><span id="a-title">Alpha</span><input type="checkbox"></li>
        <li class="px-trow" data-testid="row-b"><span data-testid="title-b">Bravo</span></li>
        <li class="px-trow" data-testid="row-c">Charlie</li>
      </ul>
    </div>`;
  return { root: document.getElementById('page')!, list: document.querySelector('ul')! };
}

beforeEach(() => {
  anims = [];
  Element.prototype.animate = vi.fn(function (this: Element, frames: Keyframe[], opts: KeyframeAnimationOptions) {
    const anim: FakeAnim = { onfinish: null, oncancel: null };
    anims.push({ el: this, frames, opts, anim });
    return anim as unknown as Animation;
  }) as typeof Element.prototype.animate;
});

afterEach(() => {
  stop();
  Element.prototype.animate = realAnimate;
  document.body.innerHTML = '';
});

describe('watchRowExits', () => {
  it('puts a ghost where a removed row was, collapses it, then takes it away', async () => {
    const { root, list } = page();
    stop = watchRowExits(root);
    const b = list.querySelector('[data-testid="row-b"]')!;
    b.remove();
    await flush();

    const ghost = list.children[1] as HTMLElement;
    expect(ghost.classList.contains('px-row-ghost')).toBe(true);
    expect(ghost.textContent).toBe('Bravo'); // where it was: between Alpha and Charlie
    expect(list.children[2]!.getAttribute('data-testid')).toBe('row-c');
    // findable by nothing, usable by no one
    expect(ghost.hasAttribute('data-testid')).toBe(false);
    expect(ghost.querySelector('[data-testid]')).toBeNull();
    expect(ghost.getAttribute('aria-hidden')).toBe('true');
    expect(ghost.hasAttribute('inert')).toBe(true);
    // fades and closes over ROW_EXIT_MS
    expect(anims).toHaveLength(1);
    expect(anims[0]!.el).toBe(ghost);
    expect(anims[0]!.opts.duration).toBe(ROW_EXIT_MS);
    expect(anims[0]!.frames.at(-1)).toMatchObject({ height: '0px', opacity: 0 });

    anims[0]!.anim.onfinish!();
    expect(list.querySelector('.px-row-ghost')).toBeNull();
    expect([...list.children].map((li) => li.getAttribute('data-testid'))).toEqual(['row-a', 'row-c']);
    await flush();
    expect(anims).toHaveLength(1); // the ghost's own removal is not a row leaving
  });

  it('strips ids and keeps what an input showed', async () => {
    const { root, list } = page();
    stop = watchRowExits(root);
    const a = list.querySelector('[data-testid="row-a"]')!;
    a.querySelector('input')!.checked = true; // live state, not an attribute
    a.remove();
    await flush();
    const ghost = list.querySelector('.px-row-ghost')!;
    expect(ghost.querySelector('[id]')).toBeNull();
    expect(ghost.querySelector('input')!.checked).toBe(true);
    expect(list.firstElementChild).toBe(ghost); // it was first
  });

  it('a row that was MOVED is not a removal', async () => {
    const { root, list } = page();
    stop = watchRowExits(root);
    list.insertBefore(list.lastElementChild!, list.firstElementChild); // what React does to reorder
    await flush();
    expect(list.querySelector('.px-row-ghost')).toBeNull();
    expect(anims).toHaveLength(0);
  });

  it('a row replaced in place by a new node for the same item is not a removal', async () => {
    const { root, list } = page();
    stop = watchRowExits(root);
    const old = list.querySelector('[data-testid="row-b"]')!;
    const fresh = old.cloneNode(true);
    list.replaceChild(fresh, old);
    await flush();
    expect(list.querySelector('.px-row-ghost')).toBeNull();
  });

  it('a whole list going away leaves nothing behind', async () => {
    const { root, list } = page();
    stop = watchRowExits(root);
    list.remove();
    await flush();
    expect(root.querySelector('.px-row-ghost')).toBeNull();
    expect(anims).toHaveLength(0);
  });

  it('placeholder rows ("Nothing available") just go', async () => {
    const { root, list } = page();
    list.insertAdjacentHTML('beforeend', '<li class="px-trow px-muted">Nothing available.</li>');
    stop = watchRowExits(root);
    list.querySelector('.px-muted')!.remove();
    await flush();
    expect(anims).toHaveLength(0);
  });

  it('reduced motion: rows just go', async () => {
    const realMatch = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes('reduce'), media: q })) as unknown as typeof window.matchMedia;
    try {
      const { root, list } = page();
      stop = watchRowExits(root);
      list.querySelector('[data-testid="row-b"]')!.remove();
      await flush();
      expect(list.querySelector('.px-row-ghost')).toBeNull();
    } finally {
      window.matchMedia = realMatch;
    }
  });

  it('stops watching when told to', async () => {
    const { root, list } = page();
    watchRowExits(root)();
    list.querySelector('[data-testid="row-b"]')!.remove();
    await flush();
    expect(list.querySelector('.px-row-ghost')).toBeNull();
  });
});
