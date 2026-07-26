// src/screens/HomeScreen.jsx
//
// Replaces the old full-screen MapScreen as the "Home" tab content.
// Layout: hero Map Preview Card (tap -> full-screen map + trail + share),
// a "Get" button that expands a realtime cattle info panel below it,
// and a Weather Card at the bottom.

import { useState } from 'react';
import MapPreviewCard from '../components/MapPreviewCard';
import FullMapModal from '../components/FullMapModal';
import CattleInfoPanel from '../components/CattleInfoPanel';
import WeatherCard from '../components/WeatherCard';

export default function HomeScreen({ isFarmerView }) {
  const [isMapOpen, setIsMapOpen] = useState(false);
  const [isInfoOpen, setIsInfoOpen] = useState(false);

  return (
    <div
      style={{
        height: '100%',
        overflowY: 'auto',
        padding: 12,
        display: 'flex',
        flexDirection: 'column',
        gap: 14,
        background: '#f4f6f4',
      }}
    >
      <MapPreviewCard isFarmerView={isFarmerView} onOpen={() => setIsMapOpen(true)} />

      <CattleInfoPanel
        isFarmerView={isFarmerView}
        isOpen={isInfoOpen}
        onToggle={() => setIsInfoOpen((v) => !v)}
      />

      <WeatherCard />

      {isMapOpen && (
        <FullMapModal isFarmerView={isFarmerView} onClose={() => setIsMapOpen(false)} />
      )}
    </div>
  );
}