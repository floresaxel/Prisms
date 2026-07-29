/* Prisms landing — declarative scene playback.
   A scene is any `.lp-scene`. Actors are children with `data-at="<ms>"`; at
   that offset the engine fires the actor's action (default: add `.on`, which
   CSS turns into the visible state change). Scenes auto-play when scrolled
   into view, loop while visible (data-dur + data-dwell), reset when they
   leave, and get a replay button. With prefers-reduced-motion the engine
   renders every scene's final state once and never animates. */
(() => {
  'use strict';
  const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;

  const fmtClock = (s) => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

  class Scene {
    constructor(root) {
      this.root = root;
      this.actors = [...root.querySelectorAll('[data-at]')];
      this.cursor = root.querySelector('.lp-cursor');
      const lastAt = Math.max(0, ...this.actors.map((el) => +el.dataset.at || 0));
      this.dur = +root.dataset.dur || lastAt + 1200;
      this.dwell = +root.dataset.dwell || 2200;
      this.timers = [];
      this.tickers = [];
      this.classed = []; // [el, class] pairs applied via class/unclass cues
      this.visible = false;
    }

    play() {
      this.reset();
      this.root.classList.add('lp-playing');
      for (const el of this.actors) {
        this.timers.push(setTimeout(() => this.fire(el), +el.dataset.at || 0));
      }
      this.timers.push(setTimeout(() => {
        this.root.classList.remove('lp-playing');
        if (this.visible) this.play();
      }, this.dur + this.dwell));
    }

    fire(el) {
      const act = el.dataset.act || 'on';
      switch (act) {
        case 'cursor': {
          const target = this.root.querySelector(el.dataset.target);
          if (target && this.cursor) {
            const t = target.getBoundingClientRect();
            const s = this.root.getBoundingClientRect();
            const x = t.left - s.left + t.width / 2 - 3;
            const y = t.top - s.top + t.height / 2 - 2;
            this.cursor.style.transform = `translate(${x}px, ${y}px)`;
            this.cursor.classList.add('show');
          }
          break;
        }
        case 'click':
          if (this.cursor) {
            this.cursor.classList.add('click');
            this.timers.push(setTimeout(() => this.cursor.classList.remove('click'), 450));
          }
          break;
        case 'cursor-hide':
          if (this.cursor) this.cursor.classList.remove('show');
          break;
        case 'class':
        case 'unclass': {
          const target = this.root.querySelector(el.dataset.target);
          if (target) {
            target.classList.toggle(el.dataset.class, act === 'class');
            if (act === 'class') this.classed.push([target, el.dataset.class]);
          }
          break;
        }
        case 'text':
          el.dataset.orig ??= el.textContent;
          el.textContent = el.dataset.text;
          el.classList.add('on');
          break;
        default:
          el.classList.add('on');
      }
      if (el.dataset.tick != null) this.startTick(el);
    }

    startTick(el) {
      let s = +el.dataset.tick;
      el.dataset.orig ??= el.textContent;
      const step = () => { el.textContent = fmtClock(s++); };
      step();
      this.tickers.push(setInterval(step, 1000));
    }

    reset() {
      this.timers.forEach(clearTimeout);
      this.tickers.forEach(clearInterval);
      this.timers = [];
      this.tickers = [];
      this.root.classList.remove('lp-playing');
      for (const [el, cls] of this.classed) el.classList.remove(cls);
      this.classed = [];
      for (const el of this.actors) {
        el.classList.remove('on');
        if (el.dataset.orig != null) el.textContent = el.dataset.orig;
      }
      if (this.cursor) this.cursor.classList.remove('show', 'click');
    }

    /* reduced motion: jump straight to the final state, once */
    finish() {
      for (const el of this.actors) {
        const act = el.dataset.act || 'on';
        if (act === 'class') {
          this.root.querySelector(el.dataset.target)?.classList.add(el.dataset.class);
        } else if (act === 'unclass') {
          this.root.querySelector(el.dataset.target)?.classList.remove(el.dataset.class);
        } else if (act === 'text') {
          el.textContent = el.dataset.text;
        } else if (act === 'on') {
          el.classList.add('on');
        }
        if (el.dataset.tick != null) el.textContent = el.dataset.tickStatic || fmtClock(+el.dataset.tick);
      }
    }
  }

  const init = () => {
    const scenes = [...document.querySelectorAll('.lp-scene')].map((root) => new Scene(root));

    if (REDUCED) {
      scenes.forEach((s) => s.finish());
      return;
    }

    // replay affordance
    for (const scene of scenes) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'lp-replay';
      btn.setAttribute('aria-label', 'Replay animation');
      btn.innerHTML = '<svg class="lp-ic" aria-hidden="true"><use href="#i-replay"/></svg>';
      btn.addEventListener('click', () => scene.play());
      scene.root.appendChild(btn);
    }

    const io = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const scene = scenes.find((s) => s.root === entry.target);
        if (!scene) continue;
        if (entry.isIntersecting && !scene.visible) {
          scene.visible = true;
          scene.play();
        } else if (!entry.isIntersecting && scene.visible) {
          scene.visible = false;
          scene.reset();
        }
      }
    }, { threshold: 0.3 });
    scenes.forEach((s) => io.observe(s.root));
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
