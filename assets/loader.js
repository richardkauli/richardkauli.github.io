(function () {
  const d = document;

  function isVisibleImage(img) {
    if (!img) return false;
    const st = getComputedStyle(img);
    if (st.display === 'none' || st.visibility === 'hidden') return false;
    const rect = img.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getFirstHero() {
    const imgs = Array.from(d.querySelectorAll('img')).filter(isVisibleImage);
    if (!imgs.length) return null;
    const hero = imgs.find((el) => {
      const cls = `${el.className || ''} ${el.id || ''}`;
      return /hero|banner|cover/i.test(cls) || el.dataset.hero !== undefined;
    });
    return hero || imgs[0];
  }

  function injectLoader(fontFamily) {
    d.documentElement.classList.add('loading');
    d.body.classList.add('loading');
    const wrap = d.createElement('div');
    wrap.className = 'rk-loader';
    wrap.innerHTML = `
      <div class="rk-stack" style="font-family:${fontFamily}">
        <div class="rk-bar" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-valuenow="0" aria-label="Page loading">
          <span></span>
        </div>
        <div class="rk-caption" aria-live="polite">Loading.</div>
      </div>
    `;
    d.body.appendChild(wrap);
    return wrap;
  }

  function cycleCaption(node) {
    const frames = ['Loading.', 'Loading..', 'Loading...'];
    let i = 0;
    return setInterval(() => {
      i = (i + 1) % frames.length;
      node.textContent = frames[i];
    }, 400);
  }

  function setProgress(wrap, value) {
    const bar = wrap.querySelector('.rk-bar');
    const fill = wrap.querySelector('.rk-bar > span');
    const val = Math.max(0, Math.min(100, Math.round(value)));
    bar.setAttribute('aria-valuenow', String(val));
    fill.style.width = `${val}%`;
  }

  function done(wrap, focusState) {
    requestAnimationFrame(() => {
      wrap.classList.add('hide');
      d.documentElement.classList.remove('loading');
      d.body.classList.remove('loading');
      setTimeout(() => {
        wrap.remove();
        const { hadTabIndex, previousTabIndex } = focusState;
        try {
          d.body.focus({ preventScroll: true });
        } catch (e) {
          // Ignore focus errors
        }
        if (!hadTabIndex) {
          d.body.removeAttribute('tabindex');
        } else if (previousTabIndex !== null) {
          d.body.setAttribute('tabindex', previousTabIndex);
        }
      }, 200);
    });
  }

  async function streamImage(img, wrap) {
    if (!window.fetch || !window.ReadableStream) return false;
    const rawSrc = img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src');
    if (!rawSrc) return false;
    let url;
    try {
      url = new URL(rawSrc, window.location.href);
    } catch (e) {
      return false;
    }
    if (url.origin !== window.location.origin) return false;

    const response = await fetch(url.href, { cache: 'force-cache' });
    if (!response.ok || !response.body) return false;

    const contentLength = Number(response.headers.get('content-length')) || 0;
    const reader = response.body.getReader();
    let received = 0;
    const chunks = [];

    while (true) {
      const { done: readerDone, value } = await reader.read();
      if (readerDone) break;
      if (value) {
        chunks.push(value);
        received += value.byteLength;
        if (contentLength) {
          const percent = Math.min(99, (received / contentLength) * 100);
          setProgress(wrap, percent);
        }
      }
    }

    const blob = new Blob(chunks);
    const objectUrl = URL.createObjectURL(blob);

    await new Promise((resolve, reject) => {
      const cleanup = () => {
        img.removeEventListener('load', onLoad);
        img.removeEventListener('error', onError);
      };
      const onLoad = () => {
        cleanup();
        resolve();
      };
      const onError = (event) => {
        cleanup();
        reject(event);
      };
      img.addEventListener('load', onLoad, { once: true });
      img.addEventListener('error', onError, { once: true });
      img.src = objectUrl;
    });

    if (typeof img.decode === 'function') {
      try {
        await img.decode();
      } catch (e) {
        // ignore decode errors
      }
    }

    URL.revokeObjectURL(objectUrl);
    setProgress(wrap, 100);
    return true;
  }

  async function fallbackImage(img, wrap) {
    let progress = 0;
    const tick = () => {
      if (progress < 90) {
        const increment = progress < 50 ? 5 : progress < 80 ? 3 : 1;
        progress = Math.min(90, progress + increment);
        setProgress(wrap, progress);
      }
    };
    const timer = window.setInterval(tick, 160);

    if ('loading' in img) {
      img.loading = 'eager';
    }

    await new Promise((resolve) => {
      const cleanup = () => {
        img.removeEventListener('load', onLoad);
        img.removeEventListener('error', onLoad);
      };
      const onLoad = () => {
        cleanup();
        resolve();
      };
      if (img.complete && img.naturalWidth > 0) {
        cleanup();
        resolve();
      } else {
        img.addEventListener('load', onLoad, { once: true });
        img.addEventListener('error', onLoad, { once: true });
      }
    });

    if (typeof img.decode === 'function') {
      try {
        await img.decode();
      } catch (e) {
        // ignore decode errors
      }
    }

    window.clearInterval(timer);
    setProgress(wrap, 100);
  }

  async function loadTarget(img) {
    if (img.complete && img.naturalWidth > 0) {
      return;
    }

    if (img.dataset && img.dataset.src && !img.getAttribute('src')) {
      img.setAttribute('src', img.dataset.src);
    }

    const computed = getComputedStyle(d.body);
    const fontFamily = computed.fontFamily || 'inherit';
    const wrap = injectLoader(fontFamily);
    const caption = wrap.querySelector('.rk-caption');
    const cycle = cycleCaption(caption);
    const hadTabIndex = d.body.hasAttribute('tabindex');
    const previousTabIndex = hadTabIndex ? d.body.getAttribute('tabindex') : null;
    if (!hadTabIndex) {
      d.body.setAttribute('tabindex', '-1');
    }

    try {
      const streamed = await streamImage(img, wrap);
      if (!streamed) {
        await fallbackImage(img, wrap);
      }
    } catch (e) {
      await fallbackImage(img, wrap);
    } finally {
      window.clearInterval(cycle);
      done(wrap, { hadTabIndex, previousTabIndex });
    }
  }

  function init() {
    const target = getFirstHero();
    if (!target) return;
    if (target.complete && target.naturalWidth > 0) return;
    loadTarget(target);
  }

  if (d.readyState === 'loading') {
    d.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
