(function () {
  'use strict';

  const MAX_CONCURRENCY = 3;
  const PREFETCH_AHEAD = 2;
  const COMPLETED = new Set();
  const IN_FLIGHT = new Set();
  const QUEUE = [];
  const PREFETCH_LINKS = new Map();
  const ATTEMPTS = new Map();
  let scheduled = false;
  let activeCount = 0;
  const isDev = /localhost|127\.0\.0\.1/.test(location.hostname);
  const startTime = performance.now();

  // Galleries can opt out via data-preload-off on the container.

  function absoluteUrl(url) {
    try {
      return new URL(url, document.baseURI).href;
    } catch (err) {
      return null;
    }
  }

  function parseSrcset(srcset) {
    if (!srcset) return [];
    return srcset
      .split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const spaceIndex = part.lastIndexOf(' ');
        if (spaceIndex === -1) {
          return { url: part, density: null, width: null };
        }
        const url = part.slice(0, spaceIndex);
        const descriptor = part.slice(spaceIndex + 1).trim();
        if (descriptor.endsWith('x')) {
          return {
            url,
            density: parseFloat(descriptor.replace('x', '')) || 1,
            width: null,
          };
        }
        if (descriptor.endsWith('w')) {
          return {
            url,
            density: null,
            width: parseInt(descriptor.replace('w', ''), 10) || null,
          };
        }
        return { url: part, density: null, width: null };
      });
  }

  function chooseCandidate(candidates) {
    if (!candidates.length) return null;
    const dpr = window.devicePixelRatio || 1;
    const densityCandidates = candidates
      .filter((c) => typeof c.density === 'number')
      .sort((a, b) => a.density - b.density);
    if (densityCandidates.length) {
      for (let i = 0; i < densityCandidates.length; i += 1) {
        if (densityCandidates[i].density >= dpr) {
          return densityCandidates[i].url;
        }
      }
      return densityCandidates[densityCandidates.length - 1].url;
    }

    const widthCandidates = candidates
      .filter((c) => typeof c.width === 'number')
      .sort((a, b) => a.width - b.width);
    if (widthCandidates.length) {
      const target = (window.innerWidth || screen.width || widthCandidates[widthCandidates.length - 1].width || 0) * dpr;
      for (let i = 0; i < widthCandidates.length; i += 1) {
        if (widthCandidates[i].width >= target) {
          return widthCandidates[i].url;
        }
      }
      return widthCandidates[widthCandidates.length - 1].url;
    }

    return candidates[0].url;
  }

  function getUrlFromImg(img) {
    if (!img) return null;
    const dataSrc = img.getAttribute('data-src') || img.dataset.src;
    const dataSrcset = img.getAttribute('data-srcset') || img.dataset.srcset;
    if (dataSrcset) {
      const choice = chooseCandidate(parseSrcset(dataSrcset));
      if (choice) return choice;
    }
    if (dataSrc) return dataSrc;
    if (img.currentSrc) return img.currentSrc;
    return img.getAttribute('src') || null;
  }

  function sourceIsMatch(source) {
    const media = source.media;
    if (media && typeof window.matchMedia === 'function') {
      try {
        if (!window.matchMedia(media).matches) {
          return false;
        }
      } catch (err) {
        return false;
      }
    }
    return true;
  }

  function getUrlFromPicture(picture) {
    const sources = Array.from(picture.querySelectorAll('source')).filter(sourceIsMatch);
    for (let i = 0; i < sources.length; i += 1) {
      const source = sources[i];
      const choice = chooseCandidate(parseSrcset(source.srcset || source.getAttribute('data-srcset') || ''));
      if (choice) {
        return choice;
      }
    }
    return getUrlFromImg(picture.querySelector('img'));
  }

  function collectFromAttribute(value, urls, seen) {
    if (!value) return;
    value
      .split(/[,\s]+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .forEach((raw) => {
        const url = absoluteUrl(raw);
        if (url && !seen.has(url)) {
          seen.add(url);
          urls.push(url);
        }
      });
  }

  function getGalleryImageUrls(root) {
    const urls = [];
    const seen = new Set();

    if (!root || root.hasAttribute('data-preload-off') || root.dataset.preloadOff === 'true') {
      return urls;
    }

    collectFromAttribute(root.getAttribute('data-images') || root.dataset.images, urls, seen);
    collectFromAttribute(root.getAttribute('data-src-list') || root.dataset.srcList, urls, seen);

    const elements = [];
    if (root.matches('picture, img')) {
      elements.push(root);
    }
    elements.push.apply(elements, root.querySelectorAll('picture, img'));

    for (let i = 0; i < elements.length; i += 1) {
      const el = elements[i];
      if (el.tagName === 'PICTURE') {
        const url = absoluteUrl(getUrlFromPicture(el));
        if (url && !seen.has(url)) {
          seen.add(url);
          urls.push(url);
        }
        continue;
      }
      if (el.tagName === 'IMG' && el.parentElement && el.parentElement.tagName === 'PICTURE') {
        continue;
      }
      const imgUrl = absoluteUrl(getUrlFromImg(el));
      if (imgUrl && !seen.has(imgUrl)) {
        seen.add(imgUrl);
        urls.push(imgUrl);
      }
    }

    return urls;
  }

  function removePrefetchLink(url) {
    const link = PREFETCH_LINKS.get(url);
    if (link) {
      link.remove();
      PREFETCH_LINKS.delete(url);
    }
  }

  function updatePrefetchLinks() {
    if (!document.head) return;
    const needed = [];
    for (let i = 0; i < QUEUE.length && needed.length < PREFETCH_AHEAD; i += 1) {
      const url = QUEUE[i];
      if (COMPLETED.has(url) || IN_FLIGHT.has(url)) {
        continue;
      }
      needed.push(url);
    }

    needed.forEach((url) => {
      if (!PREFETCH_LINKS.has(url)) {
        const link = document.createElement('link');
        link.rel = 'prefetch';
        link.href = url;
        link.as = 'image';
        document.head.appendChild(link);
        PREFETCH_LINKS.set(url, link);
      }
    });

    Array.from(PREFETCH_LINKS.keys()).forEach((url) => {
      if (!needed.includes(url)) {
        removePrefetchLink(url);
      }
    });
  }

  function scheduleQueue() {
    if (scheduled) return;
    scheduled = true;
    const runner = () => {
      scheduled = false;
      runQueue();
    };
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(runner, { timeout: 500 });
    } else {
      setTimeout(runner, 0);
    }
  }

  function markComplete(url) {
    IN_FLIGHT.delete(url);
    COMPLETED.add(url);
    ATTEMPTS.delete(url);
    activeCount = Math.max(0, activeCount - 1);
    removePrefetchLink(url);
    updatePrefetchLinks();
    scheduleQueue();
  }

  function runQueue() {
    updatePrefetchLinks();
    while (activeCount < MAX_CONCURRENCY && QUEUE.length) {
      const url = QUEUE.shift();
      if (!url || COMPLETED.has(url) || IN_FLIGHT.has(url)) {
        continue;
      }
      IN_FLIGHT.add(url);
      if (!ATTEMPTS.has(url)) {
        ATTEMPTS.set(url, 0);
      }
      activeCount += 1;
      warmUrl(url);
    }
  }

  function trackFailure(url, attempt, err) {
    if (isDev) {
      console.warn('[gallery-preload] Failed', url, 'attempt', attempt + 1, err);
    }
    IN_FLIGHT.delete(url);
    activeCount = Math.max(0, activeCount - 1);
    if (attempt < 1) {
      ATTEMPTS.set(url, attempt + 1);
      QUEUE.push(url);
    } else {
      removePrefetchLink(url);
      COMPLETED.add(url);
      ATTEMPTS.delete(url);
    }
    scheduleQueue();
  }

  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve();
      img.onerror = () => reject(new Error('Image failed'));
      img.src = url;
    });
  }

  function fetchImage(url) {
    return fetch(url, { cache: 'force-cache', mode: 'no-cors' });
  }

  function warmUrl(url) {
    const attempt = ATTEMPTS.get(url) || 0;
    Promise.all([loadImage(url), fetchImage(url)])
      .then(() => {
        markComplete(url);
      })
      .catch((err) => {
        trackFailure(url, attempt, err);
      });
  }

  function enqueue(url) {
    if (!url || COMPLETED.has(url) || IN_FLIGHT.has(url)) {
      return;
    }
    if (!QUEUE.includes(url)) {
      QUEUE.push(url);
      if (!ATTEMPTS.has(url)) {
        ATTEMPTS.set(url, 0);
      }
    }
  }

  function enqueueAll(urls) {
    urls.forEach(enqueue);
    scheduleQueue();
  }

  function init() {
    const loadedImages = document.querySelectorAll('img');
    for (let i = 0; i < loadedImages.length; i += 1) {
      const img = loadedImages[i];
      if (img.complete) {
        const url = absoluteUrl(img.currentSrc || img.src || img.getAttribute('data-src'));
        if (url) {
          COMPLETED.add(url);
        }
      }
    }

    const galleries = new Set();
    const selectors = ['[data-gallery]', '.gallery', '.slides', '[data-images]', '[data-src-list]'];
    for (let i = 0; i < selectors.length; i += 1) {
      const found = document.querySelectorAll(selectors[i]);
      for (let j = 0; j < found.length; j += 1) {
        galleries.add(found[j]);
      }
    }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => {});
    }

    if (!galleries.size) {
      if (isDev) {
        console.info('[gallery-preload] No galleries found');
      }
      return;
    }

    galleries.forEach((gallery) => {
      const urls = getGalleryImageUrls(gallery);
      enqueueAll(urls);
    });

    if (QUEUE.length && isDev) {
      console.info('[gallery-preload] Queued', QUEUE.length, 'images in', Math.round(performance.now() - startTime), 'ms');
    }

    scheduleQueue();

    if (isDev) {
      const logCompletion = () => {
        if (IN_FLIGHT.size === 0 && QUEUE.length === 0) {
          console.info('[gallery-preload] Completed in', Math.round(performance.now() - startTime), 'ms');
        } else {
          requestAnimationFrame(logCompletion);
        }
      };
      requestAnimationFrame(logCompletion);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  // Export helper for debugging if needed.
  window.__rkPreload = { getGalleryImageUrls };
})();
