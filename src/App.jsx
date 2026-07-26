// src/App.jsx
//
// Root app component — wires up the 4 main tabs (Home/Map, Store,
// News, Profile) with simple state-based tab switching (no router
// needed yet for a single-screen test run).

import { useState } from 'react';
import HomeScreen from './screens/HomeScreen';
import './App.css';

const TABS = [
  { id: 'map', label: '🗺️ Map' },
  { id: 'store', label: '🛒 Store' },
  { id: 'news', label: '📰 News' },
  { id: 'profile', label: '👤 Profile' },
];

function ComingSoon({ label }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
      <h2>{label} — Coming Soon</h2>
    </div>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState('map');

  // Toggle this to test the buyer/public view vs the farmer/owner view.
  const [isFarmerView, setIsFarmerView] = useState(true);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', width: '100vw' }}>
      <header
        style={{
          padding: '10px 16px',
          background: '#2e7d32',
          color: '#fff',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <strong>KisanBit</strong>
        <button
          onClick={() => setIsFarmerView((v) => !v)}
          style={{ fontSize: 12, padding: '4px 10px', borderRadius: 12, border: 'none' }}
        >
          {isFarmerView ? 'Viewing as Farmer' : 'Viewing as Buyer'}
        </button>
      </header>

      <main style={{ flex: 1, overflow: 'hidden' }}>
        {activeTab === 'map' && <HomeScreen isFarmerView={isFarmerView} />}
        {activeTab === 'store' && <ComingSoon label="Hardware Store" />}
        {activeTab === 'news' && <ComingSoon label="Agriculture & Livestock News" />}
        {activeTab === 'profile' && <ComingSoon label="Profile & Assets" />}
      </main>

      <nav style={{ display: 'flex', borderTop: '1px solid #ddd' }}>
        {TABS.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            style={{
              flex: 1,
              padding: 12,
              border: 'none',
              background: activeTab === tab.id ? '#e8f5e9' : '#fff',
              fontWeight: activeTab === tab.id ? 'bold' : 'normal',
            }}
          >
            {tab.label}
          </button>
        ))}
      </nav>
    </div>
  );
}