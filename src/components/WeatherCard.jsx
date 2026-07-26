

import { useEffect, useState } from 'react';

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
        const { latitude, longitude } = pos.coords;
        try {
          const res = await fetch(
            `https://api.openweathermap.org/data/2.5/weather?lat=${latitude}&lon=${longitude}&units=metric&appid=${apiKey}`
          );
          const data = await res.json();
          if (data.cod !== 200) throw new Error(data.message || 'Weather fetch failed');
          setWeather(data);
        } catch (err) {
          setError(err.message);
        }
      },
      () => setError('Location permission denied.')
    );
  }, []);

  return (
    <div
      style={{
        borderRadius: 16,
        background: 'linear-gradient(135deg, #4fc3f7, #29b6f6)',
        color: '#fff',
        padding: 16,
        boxShadow: '0 2px 8px rgba(0,0,0,0.08)',
        flexShrink: 0,
      }}
    >
      <div style={{ fontSize: 14, opacity: 0.9 }}>Today's Weather</div>

      {error && <div style={{ fontSize: 13, marginTop: 8 }}>{error}</div>}

      {weather && !error && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 6 }}>
          <div style={{ fontSize: 40 }}>
            {WEATHER_ICON[weather.weather?.[0]?.main] || '🌤️'}
          </div>
          <div>
            <div style={{ fontSize: 28, fontWeight: 'bold' }}>
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
