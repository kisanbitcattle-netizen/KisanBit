// src/App.jsx
//
// Root app component. Gates on Supabase auth session — shows
// AuthScreen until logged in, then the main 4-tab app.
//
// ADDED:
//  - navigator.onLine tracking + a persistent offline banner so a
//    farmer out in the field with no signal gets a clear "you're
//    offline, showing cached data" cue instead of silent stale data
//    or confusing failed-fetch errors.
//  - @capacitor/app appStateChange: on pause (app backgrounded) we
//    disconnect the shared Supabase Realtime socket so AlertBanner /
//    TransferRequestsBanner channels aren't kept alive (and billed)
//    while the screen is off in someone's pocket; on resume we
//    reconnect and do a lightweight session/profile re-check (catches
//    a session that expired while backgrounded).
//  - Native Android back button: closes the marketplace modal or
//    steps back to the Map tab instead of exiting the app straight
//    from a sub-screen; a second back press from the Map tab (root)
//    exits, matching normal Android app behavior.
//  - Wrapped the Capacitor plugin usage in a `Capacitor.isNativePlatform()`
//    guard so this still runs fine in a plain browser during `vite dev`.
//
// FIX: `user` was never actually passed down to HomeScreen - only
// `isLoggedIn` (a bare boolean) was tracked here, so
// `<HomeScreen isFarmerView={isFarmerView} />` never carried a `user`
// prop at all. HomeScreen's own cattle fetch gates on `user?.id`
// (`if (user?.id) { fetchAndSubscribeCattle(); } else { setLoading(false); }`),
// so with `user` permanently undefined that gate always took the
// "skip" branch - cattleData stayed [] forever, silently (no error),
// which is why MapPreviewCard never had anything to plot a pin from
// even though the user was fully logged in. Added a `user` state here,
// populated from the Supabase session (`session?.user`) in both the
// initial init() and the onAuthStateChange listener, and now passed
// through to HomeScreen.

import { useState, useEffect, useCallback } from 'react';
import { Capacitor } from '@capacitor/core';
import { App as CapacitorApp } from '@capacitor/app';
import Header from './components/Header';
import IoTShopModal from './features/iot/IoTShopModal';
import AlertBanner from './components/AlertBanner';
import HomeScreen from './screens/HomeScreen';
import ProfileScreen from './screens/ProfileScreen';
import AuthScreen from './screens/AuthScreen';
import { supabase } from './config/supabaseClient';
import { getCurrentSession, getCurrentProfile, onAuthStateChange } from './services/authService';
import './App.css';
import TransferRequestsBanner from './components/TransferRequestsBanner';
import { UserProvider } from './context/UserContext';

// Apply the persisted dark-mode preference as early as possible - at
// module-evaluation time, outside the component, so it runs before
// React mounts anything. Without this, the theme only got applied
// once ProfileScreen mounted, so every fresh launch briefly flashed
// the default light theme even for a user who'd chosen dark - this
// runs before first paint instead. Key name ('kisanbit_theme') and
// the data-theme attribute must stay in sync with what
// ProfileScreen.jsx's toggle reads/writes.
if (typeof document !== 'undefined') {
  const storedTheme = localStorage.getItem('kisanbit_theme');
  if (storedTheme === 'dark') {
    document.documentElement.setAttribute('data-theme', 'dark');
  }
}

const TABS = [
  { id: 'map', label: '🗺️ Map' },
  { id: 'store', label: '🔧 Hardware' },
  { id: 'news', label: '📰 News' },
  { id: 'profile', label: '👤 Profile' },
];

function ComingSoon({ label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
      <h2 className="display-text" style={{ color: 'var(--color-ink)' }}>
        {label} — Coming Soon
      </h2>
    </div>
  );
}

function OfflineBanner() {
  return (
    <div
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        zIndex: 7000,
        background: 'var(--color-danger, #c0392b)',
        color: '#fff',
        textAlign: 'center',
        padding: '6px 10px',
        fontSize: 12,
        fontWeight: 700,
      }}
    >
      📶 You're offline — showing saved data
    </div>
  );
}

export default function App() {
  const [checkingSession, setCheckingSession] = useState(true);
  const [isLoggedIn, setIsLoggedIn] = useState(false);
  // FIX: this was missing entirely - see the top-of-file FIX comment.
  // Holds the Supabase auth user object (needs at least `.id`) so it
  // can be passed down to HomeScreen, which gates its cattle fetch on
  // `user?.id`.
  const [user, setUser] = useState(null);
  const [activeTab, setActiveTab] = useState('map');
  const [isFarmerView, setIsFarmerView] = useState(true);
  const [isMarketplaceOpen, setIsMarketplaceOpen] = useState(false);
  const [listingCount, setListingCount] = useState(0);
  // IoT shop cart, lifted up from IoTShopModal so the Header cart-icon
  // badge can show a live item count instead of the unrelated
  // cattle/crop listingCount below. Shape: { [productId]: quantity }.
  const [cart, setCart] = useState({});
  const cartCount = Object.values(cart).reduce((sum, qty) => sum + qty, 0);
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  // Farmer's profile photo, shown in the bottom-nav Profile tab in place
  // of the plain emoji, falling back to the app logo when no photo has
  // been uploaded yet. Seeded from the cached profile below and kept in
  // sync by refreshProfile(); ProfileScreen also calls setAvatarUrl
  // directly the moment a NEW photo finishes uploading (see
  // onAvatarChange prop below), since that upload only ever updated
  // ProfileScreen's own local state before - nothing told App.jsx a new
  // photo existed, so the nav button never had a way to reflect it.
  const [avatarUrl, setAvatarUrl] = useState(null);

  // --- Online/offline banner ---------------------------------------
  useEffect(() => {
    const goOnline = () => setIsOnline(true);
    const goOffline = () => setIsOnline(false);
    window.addEventListener('online', goOnline);
    window.addEventListener('offline', goOffline);
    return () => {
      window.removeEventListener('online', goOnline);
      window.removeEventListener('offline', goOffline);
    };
  }, []);

  // --- Session bootstrap ---------------------------------------------
  const refreshProfile = useCallback(async () => {
    try {
      const profile = await getCurrentProfile();
      if (profile) {
        setIsFarmerView(profile.role === 'farmer');
        setAvatarUrl(profile.avatar_url || null);
        localStorage.setItem('kb_user_profile', JSON.stringify(profile));
      }
    } catch (err) {
      // Offline or session hiccup on a background refresh - keep
      // showing whatever role we already have cached, don't disrupt
      // the UI with an error for a silent background check.
      console.warn('[KisanBit] refreshProfile failed (staying on cached role):', err.message);
    }
  }, []);

  useEffect(() => {
    async function init() {
      try {
        const session = await getCurrentSession();
        setIsLoggedIn(!!session);
        // FIX: populate `user` from the session so it can be passed
        // down to HomeScreen (see top-of-file FIX comment).
        setUser(session?.user ?? null);

        if (session) {
          const cachedProfile = localStorage.getItem('kb_user_profile');
          if (cachedProfile) {
            const parsed = JSON.parse(cachedProfile);
            setIsFarmerView(parsed.role === 'farmer');
            setAvatarUrl(parsed.avatar_url || null);
          }
          // SPEED FIX: this used to be `await refreshProfile()`, which
          // held the splash screen (`checkingSession`) up until the
          // network profile fetch finished/failed - on a slow/flaky
          // field connection that could take several seconds even
          // though the cached profile above already had everything
          // needed to render the app. Now it's fire-and-forget: the app
          // shows immediately with the cached role/avatar (or the
          // farmer default if there's no cache yet, e.g. first login on
          // this device), and the fresh profile quietly replaces it
          // whenever the network call actually resolves.
          refreshProfile();
        }
      } catch (err) {
        console.error('[KisanBit] init() failed:', err.message);
      } finally {
        setCheckingSession(false);
      }
    }
    init();

    const unsubscribe = onAuthStateChange(async (session) => {
      setIsLoggedIn(!!session);
      // FIX: keep `user` in sync on every auth state change too (sign
      // in, sign out, token refresh) - not just on initial load.
      setUser(session?.user ?? null);
      if (session) {
        await refreshProfile();
      } else {
        localStorage.removeItem('kb_user_profile');
      }
    });

    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [refreshProfile]);

  // --- App pause/resume (Capacitor) -----------------------------------
  // Pausing the Realtime socket while backgrounded avoids AlertBanner/
  // TransferRequestsBanner channels sitting open (and reconnect-retrying)
  // in someone's pocket; resuming reconnects + re-checks the session so
  // a token that expired while the app was backgrounded doesn't leave
  // the UI silently stuck.
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    const listenerPromise = CapacitorApp.addListener('appStateChange', ({ isActive }) => {
      if (isActive) {
        supabase.realtime.connect();
        if (isLoggedIn) refreshProfile();
      } else {
        supabase.realtime.disconnect();
      }
    });

    return () => {
      listenerPromise.then((listener) => listener.remove());
    };
  }, [isLoggedIn, refreshProfile]);

  // --- Android back button ---------------------------------------------
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;

    const listenerPromise = CapacitorApp.addListener('backButton', () => {
      if (isMarketplaceOpen) {
        setIsMarketplaceOpen(false);
        return;
      }
      if (activeTab !== 'map') {
        setActiveTab('map');
        return;
      }
      // Already at the root (Map tab, nothing open) - let Android's
      // default behavior (minimize/exit) happen.
      CapacitorApp.exitApp();
    });

    return () => {
      listenerPromise.then((listener) => listener.remove());
    };
  }, [activeTab, isMarketplaceOpen]);

  // --- Marketplace/crop listing count, 5-min localStorage cache --------
  useEffect(() => {
    if (!isLoggedIn) return;

    async function loadCount() {
      const cachedCount = localStorage.getItem('kb_listing_count');
      const cachedTime = localStorage.getItem('kb_listing_count_time');
      const now = Date.now();

      if (cachedCount && cachedTime && now - parseInt(cachedTime, 10) < 300000) {
        setListingCount(parseInt(cachedCount, 10));
        return;
      }

      if (!isOnline) return; // don't attempt a network call while offline

      try {
        const [{ count: cattleCount }, { count: cropCount }] = await Promise.all([
          supabase.from('cattle_public_view').select('id', { count: 'exact', head: true }),
          supabase.from('crops_marketplace').select('id', { count: 'exact', head: true }).eq('is_listed', true),
        ]);

        const total = (cattleCount || 0) + (cropCount || 0);
        setListingCount(total);
        localStorage.setItem('kb_listing_count', total.toString());
        localStorage.setItem('kb_listing_count_time', now.toString());
      } catch (err) {
        console.error('[KisanBit] loadCount failed:', err.message);
      }
    }

    loadCount();
  }, [isLoggedIn, isOnline]);

  if (checkingSession) {
    return (
      <div style={{ display: 'flex', height: '100vh', alignItems: 'center', justifyContent: 'center' }}>
        <p>Loading…</p>
      </div>
    );
  }

  if (!isLoggedIn) {
    return <AuthScreen onAuthed={() => setIsLoggedIn(true)} />;
  }

  return (
    // UserProvider: makes the already-resolved `user` (from the
    // session-bootstrap effect above) available to any descendant via
    // useUser(), so AlertBanner / TransferRequestsBanner / the
    // HomeScreen panels (CattleInfoPanel, FieldInfoPanel,
    // IoTDevicesPanel, PondsPanel) stop each calling
    // supabase.auth.getUser() themselves on mount - see
    // src/context/UserContext.jsx for the full rationale.
    <UserProvider user={user}>
      <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw', background: 'var(--color-bg)' }}>
        {!isOnline && <OfflineBanner />}

        <Header
          isFarmerView={isFarmerView}
          onToggleView={setIsFarmerView}
          cartCount={cartCount}
          onOpenMarketplace={() => setIsMarketplaceOpen(true)}
        />

        {isFarmerView && (
          <>
            <AlertBanner />
            <TransferRequestsBanner />
          </>
        )}

        <main style={{ flex: 1, overflow: 'hidden' }}>
          {/* FIX: added `user={user}` - this was the missing prop (see
              top-of-file FIX comment). Everything else on this line is
              unchanged. */}
          {activeTab === 'map' && <HomeScreen isFarmerView={isFarmerView} user={user} />}
          {activeTab === 'store' && <ComingSoon label="Hardware & IoT Store" />}
          {activeTab === 'news' && <ComingSoon label="Agriculture & Livestock News" />}
          {activeTab === 'profile' && <ProfileScreen onAvatarChange={setAvatarUrl} />}
        </main>

        <nav className="kb-bottom-nav">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`kb-nav-btn ${activeTab === tab.id ? 'active' : ''}`}
              style={{ minHeight: 48 }}
            >
              {tab.id === 'profile' ? (
                // Shows the farmer's own uploaded photo (avatarUrl) once
                // set; falls back to the app logo (same asset Header.jsx
                // already uses) rather than a plain person emoji when no
                // photo has been uploaded yet.
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
                  <span
                    style={{
                      width: 18, height: 18, borderRadius: '50%', overflow: 'hidden',
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      flexShrink: 0, background: 'var(--color-border)',
                    }}
                  >
                    <img
                      src={avatarUrl || '/assets/branding/kisanbit-logo.png'}
                      alt=""
                      style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                    />
                  </span>
                  Profile
                </span>
              ) : (
                tab.label
              )}
            </button>
          ))}
        </nav>

        {isMarketplaceOpen && <IoTShopModal onClose={() => setIsMarketplaceOpen(false)} cart={cart} setCart={setCart} />}
      </div>
    </UserProvider>
  );
}