// src/components/OfflineTileLayer.jsx
//
// Offline-capable replacement for react-leaflet's plain <TileLayer>.
// Uses leaflet.offline (v3.2.1 - confirmed via `npm ls`) to serve tiles
// from IndexedDB when already cached, falling back to network otherwise.
//
// IMPORTANT, re-verified against the actual installed version: v2/v3 of
// this library has a DIFFERENT API from v1. There is no `L.control.
// savetiles` in v2/v3 (that only ever existed in v1). Creating the layer
// with `L.tileLayer.offline(url, options)` and adding it to the map -
// which is ALL this file used to do - only makes the layer capable of
// READING tiles from IndexedDB if they're already there. It does NOT
// automatically save new tiles it fetches. Saving requires manually
// listening for the layer's own 'tileload' event and calling the
// library's downloadTile()/saveTile() functions per tile - this is the
// pattern confirmed from a real working example in the library's own
// GitHub issue tracker (allartk/leaflet.offline, issue #314), not
// guessed.
//
// This component was previously imported in FullMapModal.jsx but never
// actually rendered in its JSX, so tiles were never cached at all -
// meaning every page refresh re-downloaded every visible map tile fresh
// from OpenStreetMap. That's the leading suspect for the ~44MB/149-
// request bandwidth issue.
//
// Also previously missing a cleanup function entirely - if this
// component ever unmounts/remounts (map modal closing and reopening),
// the old tile layer was never removed from the map, so a second layer
// would stack on top of the first instead of replacing it.
//
// THEME-AWARE TILES: also now switches between OSM (light) and a
// CSS-inverted dark look (dark) based on <html data-theme>, tracked via
// a MutationObserver and rebuilding the layer (remove + re-add, reusing
// the same cleanup path above) whenever the theme flips.
// CACHING NOTE: light and dark now request the SAME underlying OSM tile
// URL (dark mode used to point at a separate CARTO endpoint - see
// TILE_URLS comment below for why that was dropped), darkened only via
// a CSS filter on the tile container. So both themes now share one
// IndexedDB cache entry per tile instead of two - fewer tiles to store,
// and a tile cached in one theme is instantly available in the other.
import { useEffect, useState } from 'react';
import { useMap } from 'react-leaflet';
import L from 'leaflet';
import 'leaflet.offline';
import { downloadTile, saveTile } from 'leaflet.offline';

// Tile source per theme. <html data-theme="dark"> is set/persisted by
// App.jsx (applied at module-eval time, before first paint) and toggled
// by ProfileScreen.jsx - same attribute every component using
// var(--color-*) already reacts to. Previously this component always
// requested the OSM light tiles regardless of theme, which is why the
// map background stayed light even when the rest of the app was dark.
//
// FIX: dark mode used to point at CARTO's dark_all basemap
// (a.basemaps.cartocdn.com). CARTO has since started gating that free
// anonymous endpoint behind a required API key - without one, every
// tile now renders as a blank tile stamped "API KEY REQUIRED,
// carto.com/basemaps/apikey" instead of an actual map (confirmed via a
// live screenshot showing exactly that watermark). Rather than sign up
// for and manage a CARTO API key, dark mode now reuses the SAME
// key-free OSM tile URL as light mode - the actual darkening happens
// via the CSS `invert` filter below instead of a different tile
// source, a common no-key trick for a dark Leaflet basemap.
const TILE_URLS = {
  light: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  dark: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
};
const TILE_ATTRIBUTIONS = {
  light: '&copy; OpenStreetMap contributors',
  dark: '&copy; OpenStreetMap contributors',
};

function readTheme() {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
}

// Props mirror the ones FullMapModal.jsx was already passing to the
// plain <TileLayer> it's replacing (maxZoom=16, keepBuffer=1,
// detectRetina=false) - defaults here match Leaflet's own TileLayer
// defaults for anywhere else this component might get reused without
// explicit props.
export default function OfflineTileLayer({ maxZoom = 19, keepBuffer = 1, detectRetina = false }) {
  const map = useMap();

  // Live theme state, kept in sync with <html data-theme>. A MutationObserver
  // (not a prop/context) is needed because ProfileScreen.jsx's toggle sets
  // the attribute directly on document.documentElement - this component has
  // no other way to hear about that change.
  const [theme, setTheme] = useState(readTheme);

  useEffect(() => {
    const observer = new MutationObserver(() => setTheme(readTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    if (!map) return;

    // DEFENSIVE (added after a report of the entire map block vanishing,
    // not just tiles failing to load): L.tileLayer.offline() opens an
    // IndexedDB database as part of its setup. This runs synchronously
    // inside this effect with no React error boundary above it, so if
    // IndexedDB access throws for any reason - untrusted/self-signed
    // HTTPS origin, storage permissions, browser private-mode blocking
    // IndexedDB entirely, etc - the exception was propagating up and
    // taking the whole component subtree down with it (buttons still
    // rendered, the 480px map block itself just disappeared). Falling
    // back to a plain, non-caching L.tileLayer keeps the map itself
    // always renderable; offline caching becomes best-effort instead of
    // a single point of failure for the primary feature.
    let offlineLayer;
    try {
      offlineLayer = L.tileLayer.offline(
        TILE_URLS[theme],
        {
          attribution: TILE_ATTRIBUTIONS[theme],
          maxZoom,
          keepBuffer,
          detectRetina,
        }
      );
    } catch (err) {
      console.error('[OfflineTileLayer] offline layer init failed, falling back to plain TileLayer (no caching this session):', err);
      offlineLayer = L.tileLayer(
        TILE_URLS[theme],
        {
          attribution: TILE_ATTRIBUTIONS[theme],
          maxZoom,
          keepBuffer,
          detectRetina,
        }
      );
    }

    // Persist every tile that actually comes from the network into
    // IndexedDB, so the NEXT time this same tile is needed - next pan,
    // next app open, next refresh - it's served from cache instead of
    // re-downloaded. Tiles the layer already served FROM its own cache
    // come back as blob: URLs (leaflet.offline's own convention, per the
    // GitHub example) - skip re-saving those, only persist genuine
    // network fetches.
    const handleTileLoad = (event) => {
      const { tile } = event;
      const url = tile?.src;
      if (!url || url.startsWith('blob:')) return;

      const { x, y, z } = event.coords;
      const tileInfo = {
        key: url,
        url,
        x,
        y,
        z,
        urlTemplate: offlineLayer._url,
        createdAt: Date.now(),
      };

      downloadTile(url)
        .then((blob) => saveTile(tileInfo, blob))
        .catch((err) => {
          // Best-effort - a failed cache write should never break the
          // map. The tile is already showing on screen either way,
          // this only affects whether it's cached for NEXT time.
          console.warn('[OfflineTileLayer] failed to cache tile:', url, err);
        });
    };

    offlineLayer.on('tileload', handleTileLoad);
    offlineLayer.addTo(map);

    // CARTO Dark Matter is gone (see TILE_URLS comment above) - dark mode
    // now darkens the same OSM tiles everything else uses, via a CSS
    // invert filter instead of a different tile source. invert(1) flips
    // light roads/land dark and dark water/text light; hue-rotate(180deg)
    // un-does the color-wheel flip invert() causes on its own (so water
    // reads blue-ish, not orange); brightness/contrast/saturate are
    // tuned so it doesn't look washed-out or neon, replacing the old
    // CARTO-specific tuning. Only applied in dark theme; light (OSM)
    // tiles are left as-is.
    if (theme === 'dark') {
      const container = offlineLayer.getContainer?.();
      if (container) {
        container.style.filter = 'invert(1) hue-rotate(180deg) brightness(0.95) contrast(0.85) saturate(0.7)';
      }
    }

    // CLEANUP - was missing entirely before this fix. Without this,
    // every remount of this component stacked another tile layer on
    // top of the map instead of replacing the old one.
    return () => {
      offlineLayer.off('tileload', handleTileLoad);
      map.removeLayer(offlineLayer);
    };
  }, [map, maxZoom, keepBuffer, detectRetina, theme]);

  return null;
}