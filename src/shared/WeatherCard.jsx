// src/components/WeatherCard.jsx
//
// Today's weather, card-styled, sitting below the Cattle Info panel.
// Uses the free OpenWeatherMap API tier (per the original spec) and
// the device's geolocation. Requires VITE_OPENWEATHER_API_KEY in .env
// (free key from https://openweathermap.org/api).

import { useEffect, useState } from 'react';
import { offlineCache } from '../utils/offlineCache';

const WEATHER_TTL_MS = 60 * 60 * 1000; // 1 hour

const WEATHER_ICON = {
  Clear: '☀️',
  Clouds: '☁️',
  Rain: '🌧️',
  Drizzle: '🌦️',
  Thunderstorm: '⛈️',
  Snow: '❄️',
  Mist: '🌫️',
  Haze: '🌫️',
  Fog: '🌫️',
};

export default function WeatherCard() {
  const [weather, setWeather] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    const apiKey = import.meta.env.VITE_OPENWEATHER_API_KEY;
    if (!apiKey) {
      setError('Weather API key not configured.');
      return;
    }

    if (!navigator.geolocation) {
      setError('Location not available on this device.');
      return;
    }

    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        // Round to 2 decimal places (~1.1km) so every farmer in roughly
        // the same village shares one cache entry/API call instead of
        // each device hitting OpenWeather separately.
        const latKey = pos.coords.latitude.toFixed(2);
        const lonKey = pos.coords.longitude.toFixed(2);
        const cacheKey = `weather_${latKey}_${lonKey}`;
        // Remember this location so a future geolocation failure/timeout
        // can still fall back to the last place we successfully got a
        // fix for, instead of having nothing to look up at all.
        offlineCache.setMeta('weather_last_location', { latKey, lonKey });

        try {
          const cached = await offlineCache.getMeta(cacheKey);
          if (cached && Date.now() - cached.fetchedAt < WEATHER_TTL_MS) {
            setWeather(cached.data);
            return; // fresh enough - no API call
          }
          // Cache is stale (or missing) but we're offline - show
          // whatever we have rather than attempting a doomed fetch,
          // and skip straight past the network try/catch below.
          if (!navigator.onLine) {
            if (cached?.data) {
              setWeather(cached.data);
            } else {
              setError('Offline — no cached weather for this location yet.');
            }
            return;
          }
        } catch {
          // cache read failed - fall through to a fresh fetch
        }

        try {
          const controller = new AbortController();
          const timeoutId = setTimeout(() => controller.abort(), 8000);
          const res = await fetch(
            `https://api.openweathermap.org/data/2.5/weather?lat=${latKey}&lon=${lonKey}&units=metric&appid=${apiKey}`,
            { signal: controller.signal }
          );
          clearTimeout(timeoutId);
          const data = await res.json();
          if (data.cod !== 200) throw new Error(data.message || 'Weather fetch failed');
          setWeather(data);
          offlineCache.setMeta(cacheKey, { data, fetchedAt: Date.now() });
        } catch (err) {
          // Network/API call failed - if we have ANY cached reading for this
          // spot (even a stale one), show it rather than a bare error.
          try {
            const stale = await offlineCache.getMeta(cacheKey);
            if (stale?.data) {
              setWeather(stale.data);
              return;
            }
          } catch {
            // no cache either - fall through to showing the error
          }
          setError(err.message);
        }
      },
      async (geoErr) => {
        // getCurrentPosition failed (timeout, position unavailable, or
        // permission denied) - this used to leave the card on "Loading…"
        // forever if it hung, or show a bare error with no attempt to
        // fall back to anything already cached. Try the last location we
        // successfully got a fix for before giving up.
        try {
          const lastLoc = await offlineCache.getMeta('weather_last_location');
          if (lastLoc) {
            const cached = await offlineCache.getMeta(`weather_${lastLoc.latKey}_${lastLoc.lonKey}`);
            if (cached?.data) {
              setWeather(cached.data);
              return;
            }
          }
        } catch {
          // no fallback available - fall through to showing the error
        }
        setError(
          geoErr.code === 1
            ? 'Location permission denied.'
            : 'Could not get your location — showing no weather yet.'
        );
      },
      // 8s timeout so a weak/slow GPS fix fails fast into the fallback
      // above instead of leaving the card stuck on "Loading…" with no
      // ceiling. maximumAge accepts a recent cached device position
      // (up to 10 min old) instead of forcing a brand new fix every time.
      { timeout: 8000, maximumAge: 10 * 60 * 1000 }
    );
  }, []);

  return (
    <div
      className="kb-card"
      style={{
        background: 'linear-gradient(135deg, var(--color-navy), var(--color-navy-dark))',
        color: '#f5f5f0',
        padding: 16,
        flexShrink: 0,
        borderColor: 'var(--color-gold)',
      }}
    >
      <div className="display-text" style={{ fontSize: 14, opacity: 0.9 }}>Today's Weather</div>

      {error && <div style={{ fontSize: 13, marginTop: 8 }}>{error}</div>}

      {weather && !error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 }}>
          <div style={{ fontSize: 40 }}>
            {WEATHER_ICON[weather.weather?.[0]?.main] || '🌤️'}
          </div>
          <div>
            <div style={{ fontSize: 28, fontWeight: 'bold', color: 'var(--color-gold)' }}>
              {Math.round(weather.main.temp)}°C
            </div>
            <div style={{ fontSize: 13, opacity: 0.9, textTransform: 'capitalize' }}>
              {weather.weather?.[0]?.description} · {weather.name}
            </div>
            <div style={{ fontSize: 12, opacity: 0.8, marginTop: 2 }}>
              Humidity {weather.main.humidity}% · Wind {weather.wind.speed} m/s
            </div>
          </div>
        </div>
      )}

      {!weather && !error && <div style={{ fontSize: 13, marginTop: 8 }}>Loading…</div>}
    </div>
  );
}