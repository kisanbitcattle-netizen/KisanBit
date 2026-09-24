// src/components/MarketplaceModal.jsx
//
// The "bucket" buyers were missing - opened from the cart icon in the
// header. Lists every listed cattle (from cattle_public_view, so no
// live location, only the geofence-safe public fields) and every
// listed crop (from crops_marketplace).

import { useEffect, useState } from 'react';
import { supabase } from '../config/supabaseClient';
import CattleDetailModal from './CattleDetailModal';

export default function MarketplaceModal({ onClose }) {
 const [cattle, setCattle] = useState([]);
 const [crops, setCrops] = useState([]);
 const [tab, setTab] = useState('cattle');
 const [selectedCattle, setSelectedCattle] = useState(null);

 // NOTE: dependency array was already correct ([], runs once on mount) -
 // no infinite-loop risk here. Added a `cancelled` guard for unmount
 // safety and narrowed both selects to only the columns this modal
 // actually renders, instead of pulling every column with '*'.
 useEffect(() => {
 let cancelled = false;

 async function load() {
 if (!navigator.onLine) return; // no signal - keep whatever was last loaded rather than a failed round trip
 const [{ data: cattleData, error: cattleError }, { data: cropData, error: cropError }] = await Promise.all([
 supabase
 .from('cattle_public_view')
 // average_rating/rating_count DO NOT EXIST as live columns - selecting
 // them failed the ENTIRE query (Postgres 42703), which is why this
 // tab was silently showing "No cattle listed right now" even with
 // real listings. Ratings live in the separate cattle_ratings table.
 .select('id, name, animal_type, marketplace_photo_url, sale_price_min, sale_price_max'),
 supabase
 .from('crops_marketplace')
 .select('id, crop_type, status, delivery_type, market_price')
 .eq('is_listed', true),
 ]);
 if (cancelled) return;
 // Previously swallowed - a failed fetch looked identical to "0
 // listings" in the UI. Logging the real error for developers.
 if (cattleError) console.error('[MarketplaceModal] cattle fetch failed:', cattleError.message, cattleError.details, cattleError.hint, cattleError.code);
 if (cropError) console.error('[MarketplaceModal] crop fetch failed:', cropError.message, cropError.details, cropError.hint, cropError.code);
 setCattle(cattleData || []);
 setCrops(cropData || []);
 }
 load();

 return () => {
 cancelled = true;
 };
 }, []);

 return (
 <div
 style={{
 position: 'fixed',
 inset: 0,
 zIndex: 4000,
 background: 'rgba(20,24,40,0.45)',
 display: 'flex',
 alignItems: 'flex-end',
 }}
 onClick={onClose}
 >
 <div
 className="kb-card"
 onClick={(e) => e.stopPropagation()}
 style={{
 width: '100%',
 maxHeight: '80vh',
 borderBottomLeftRadius: 0,
 borderBottomRightRadius: 0,
 display: 'flex',
 flexDirection: 'column',
 }}
 >
 <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottom: '1px solid var(--color-border)' }}>
 <span className="display-text" style={{ fontSize: 17, color: 'var(--color-navy)' }}>
 Marketplace
 </span>
 <button onClick={onClose} style={{ border: 'none', background: 'transparent', fontSize: 18 }}>x</button>
 </div>

 <div style={{ display: 'flex', borderBottom: '1px solid var(--color-border)' }}>
 <button
 onClick={() => setTab('cattle')}
 style={{
 flex: 1, padding: 12, border: 'none', background: 'transparent',
 fontWeight: tab === 'cattle' ? 700 : 500,
 color: tab === 'cattle' ? 'var(--color-navy)' : 'var(--color-muted)',
 borderBottom: tab === 'cattle' ? '2px solid var(--color-gold)' : '2px solid transparent',
 }}
 >
 Cattle ({cattle.length})
 </button>
 <button
 onClick={() => setTab('crops')}
 style={{
 flex: 1, padding: 12, border: 'none', background: 'transparent',
 fontWeight: tab === 'crops' ? 700 : 500,
 color: tab === 'crops' ? 'var(--color-navy)' : 'var(--color-muted)',
 borderBottom: tab === 'crops' ? '2px solid var(--color-gold)' : '2px solid transparent',
 }}
 >
 Crops ({crops.length})
 </button>
 </div>

 <div style={{ overflowY: 'auto', padding: 12 }}>
 {tab === 'cattle' && (
 cattle.length === 0
 ? <p style={{ color: 'var(--color-muted)', textAlign: 'center', padding: 20 }}>No cattle listed right now.</p>
 : cattle.map((c) => (
 <div
 key={c.id}
 onClick={() => setSelectedCattle({
 id: c.id,
 name: c.name,
 animalType: c.animal_type,
 marketplacePhotoUrl: c.marketplace_photo_url,
 salePriceMin: c.sale_price_min,
 salePriceMax: c.sale_price_max,
 averageRating: c.average_rating,
 ratingCount: c.rating_count,
 })}
 style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 8px', borderBottom: '1px solid var(--color-border)', cursor: 'pointer' }}
 >
 <div>
 <div style={{ fontWeight: 600 }}>{c.name}</div>
 <div style={{ fontSize: 13, color: 'var(--color-muted)' }}>
 {c.animal_type}
 {c.average_rating != null && ` - \u2605 ${c.average_rating} (${c.rating_count})`}
 </div>
 </div>
 <div style={{ fontWeight: 700, color: 'var(--color-success)' }}>
 Rs{c.sale_price_min}-{c.sale_price_max}
 </div>
 </div>
 ))
 )}

 {tab === 'crops' && (
 crops.length === 0
 ? <p style={{ color: 'var(--color-muted)', textAlign: 'center', padding: 20 }}>No crops listed right now.</p>
 : crops.map((c) => (
 <div key={c.id} style={{ display: 'flex', justifyContent: 'space-between', padding: '12px 8px', borderBottom: '1px solid var(--color-border)' }}>
 <div>
 <div style={{ fontWeight: 600 }}>{c.crop_type}</div>
 <div style={{ fontSize: 13, color: 'var(--color-muted)' }}>
 {c.status.replace('_', ' ')} - {c.delivery_type.replace('_', ' ')}
 </div>
 </div>
 <div style={{ fontWeight: 700, color: 'var(--color-success)' }}>Rs{c.market_price}</div>
 </div>
 ))
 )}
 </div>
 </div>

 {selectedCattle && (
 <CattleDetailModal cattle={selectedCattle} onClose={() => setSelectedCattle(null)} />
 )}
 </div>
 );
}