// src/components/FieldDetailModal.jsx
//
// Full detail popup for a field/polam pin: owner name/village/rating,
// current + past crops (from crops_marketplace, newest first), each
// crop's restricted_inputs (what NOT to use next), and a star rating
// the viewer can submit for the farmer.
//
// PRIVACY: this modal had TWO separate direct Call/WhatsApp spots -
// one at the field-owner level, one per crop listing. Both are now
// Chat buttons instead (listingType='field' for the owner-level one,
// listingType='crop' per crop) - see ChatModal.jsx. Neither renders
// for the field's own owner viewing their own card.
//
// FIXED: both Chat buttons used to render as soon as the component
// mounted (isOwner defaulted to false before the async
// supabase.auth.getUser() call resolved), so on the owner's OWN field
// they'd flash visible for a moment before disappearing - and tapping
// one during that window hit the server-side "You cannot start a chat
// on your own listing" rejection. Added ownerCheckDone so both
// buttons wait for the ownership check to actually finish before
// rendering at all, instead of rendering-then-hiding.

import { useEffect, useState } from 'react';
import { supabase } from '../config/supabaseClient';
import { shareFieldCard } from '../utils/shareCard';
import { offlineCache } from '../utils/offlineCache';
import ChatModal from './ChatModal';

const STATUS_LABEL = {
  growing: 'Growing',
  ready_to_harvest: 'Ready to harvest',
  harvested: 'Harvested',
};

// Standard soil-testing reference ranges (kg/ha for N/P/K available
// nutrients; pH is unitless). These are general agronomic reference
// bands, not crop-specific - swap in different thresholds if the app
// should follow a specific soil-testing authority's scale instead.
const NUTRIENT_RANGES = {
  soil_n: {
    unit: 'kg/ha',
    displayMax: 800,
    zones: [
      { upTo: 280, color: '#e74c3c', label: 'Low' },
      { upTo: 560, color: '#f1c40f', label: 'Medium' },
      { upTo: Infinity, color: '#27ae60', label: 'Good' },
    ],
  },
  soil_p: {
    unit: 'kg/ha',
    displayMax: 40,
    zones: [
      { upTo: 10, color: '#e74c3c', label: 'Low' },
      { upTo: 24, color: '#f1c40f', label: 'Medium' },
      { upTo: Infinity, color: '#27ae60', label: 'Good' },
    ],
  },
  soil_k: {
    unit: 'kg/ha',
    displayMax: 400,
    zones: [
      { upTo: 108, color: '#e74c3c', label: 'Low' },
      { upTo: 280, color: '#f1c40f', label: 'Medium' },
      { upTo: Infinity, color: '#27ae60', label: 'Good' },
    ],
  },
  soil_ph: {
    unit: '',
    displayMax: 14,
    zones: [
      { upTo: 5.5, color: '#e74c3c', label: 'Acidic' },
      { upTo: 6.5, color: '#f1c40f', label: 'Slightly acidic' },
      { upTo: 7.5, color: '#27ae60', label: 'Ideal' },
      { upTo: 8.5, color: '#f1c40f', label: 'Slightly alkaline' },
      { upTo: Infinity, color: '#e74c3c', label: 'Alkaline' },
    ],
  },
};

function categorizeNutrient(value, zones) {
  for (const zone of zones) {
    if (value <= zone.upTo) return zone;
  }
  return zones[zones.length - 1];
}

function NutrientBadge({ label, value, rangeKey }) {
  const range = NUTRIENT_RANGES[rangeKey];
  const zone = categorizeNutrient(value, range.zones);

  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 4,
        padding: '4px 8px',
        borderRadius: 12,
        fontSize: 11,
        fontWeight: 700,
        background: `${zone.color}22`,
        color: zone.color,
        border: `1px solid ${zone.color}55`,
        whiteSpace: 'nowrap',
      }}
    >
      {label} {value}{range.unit ? ` ${range.unit}` : ''} · {zone.label}
    </span>
  );
}

function StarRating({ value, onRate }) {
  return (
    <div style={{ display: 'flex', gap: 2 }}>
      {[1, 2, 3, 4, 5].map((n) => (
        <span
          key={n}
          onClick={() => onRate(n)}
          style={{ cursor: 'pointer', fontSize: 20, color: n <= value ? 'var(--color-gold)' : 'var(--color-border)' }}
        >
          ★
        </span>
      ))}
    </div>
  );
}

export default function FieldDetailModal({ field, onClose, isLiked, onToggleLike }) {
  const [summary, setSummary] = useState(null);
  const [cropHistory, setCropHistory] = useState([]);
  const [myRating, setMyRating] = useState(0);
  // CHANGED: was per-crop `sharingId` (one share button per crop, gating
  // just that crop's button while its card generated). Now one field-level
  // share covers every current crop at once, so a single boolean is enough.
  const [sharingField, setSharingField] = useState(false);
  const [loading, setLoading] = useState(true);
  const [currentUserId, setCurrentUserId] = useState(null);
  // True once the async ownership check below has actually resolved.
  // Both owner-gated Chat buttons wait on this instead of just on
  // isOwner, so neither renders-then-hides on the owner's own field
  // (see FIXED note at top of file).
  const [ownerCheckDone, setOwnerCheckDone] = useState(false);
  const [ownerChatOpen, setOwnerChatOpen] = useState(false);
  const [cropChatId, setCropChatId] = useState(null); // which crop's chat is open, if any

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getUser().then(({ data }) => {
      if (!cancelled) {
        setCurrentUserId(data?.user?.id ?? null);
        setOwnerCheckDone(true);
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Cache-first, same pattern as WeatherCard.jsx / FieldInfoPanel.jsx:
  // render instantly from whatever's already in IndexedDB (instant open,
  // works offline), then refresh from the network in the background if
  // online and update both the screen and the cache. Previously this
  // ran two fresh supabase queries on every single pin tap with nothing
  // cached at all - see offlineCache.js for the store-registration bug
  // that made that true for FieldInfoPanel too.
  //
  // NOTE: dependency array was already correct ([field.id], so this
  // only re-runs when a different field is opened - no loop risk).
  // Added a `cancelled` guard for unmount safety. field_owner_summary
  // is left as select('*') since it's a small, purpose-built view (all
  // its columns are already used across this component); crops_marketplace
  // is left as '*' too since nearly every column is rendered below
  // (photo, dates, prices, fertilizer log, contact info, QC cert, etc).
  useEffect(() => {
    let cancelled = false;

    async function load() {
      const [cachedSummaries, cachedCrops] = await Promise.all([
        offlineCache.getAll('fieldOwnerSummary'),
        offlineCache.getAll('cropsMarketplacePanel'),
      ]);
      if (cancelled) return;

      const cachedSummary = cachedSummaries.find((s) => s.id === field.id) || null;
      const cachedFieldCrops = cachedCrops
        .filter((c) => c.field_id === field.id)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));

      if (cachedSummary || cachedFieldCrops.length > 0) {
        setSummary(cachedSummary);
        setCropHistory(cachedFieldCrops);
        setLoading(false);
      }

      if (!navigator.onLine) return; // stay on cache; no doomed network call

      const [{ data: summaryRow, error: summaryError }, { data: crops, error: cropsError }] = await Promise.all([
        supabase.from('field_owner_summary').select('*').eq('id', field.id).maybeSingle(),
        supabase
          .from('crops_marketplace')
          .select('*')
          .eq('field_id', field.id)
          .order('created_at', { ascending: false }),
      ]);

      if (cancelled) return;

      // Previously these errors were silently discarded (only `data`
      // was destructured) - a failed/blocked summary fetch (e.g. RLS)
      // would leave `summary` null with no trace, which is exactly
      // what broke the isOwner check (fieldOwnerId fell through to
      // field.owner_id, which had its own separate gap in
      // FullMapModal.jsx - now fixed there too). Logging here so a
      // future failure like that shows up immediately instead of
      // silently degrading to the wrong owner check.
      if (summaryError) {
        console.error('[FieldDetailModal] field_owner_summary fetch failed:', summaryError);
      }
      if (cropsError) {
        console.error('[FieldDetailModal] crops_marketplace fetch failed:', cropsError);
      }

      setSummary(summaryRow);
      setCropHistory(crops || []);
      setLoading(false);

      // field_owner_summary includes an `id` column (the field's UUID),
      // which fits offlineCache's generic keyPath:'id' scheme directly.
      if (summaryRow) {
        offlineCache.putAll('fieldOwnerSummary', [summaryRow]);
      }
      // put() upserts by id - this only ever adds/updates this one
      // field's crop rows in the shared cache, it doesn't wipe out
      // other fields already cached there from earlier modal opens.
      if (crops && crops.length > 0) {
        offlineCache.putAll('cropsMarketplacePanel', crops);
      }

      const { data: { user } } = await supabase.auth.getUser();
      if (user && summaryRow && !cancelled) {
        const { data: existingRating } = await supabase
          .from('farmer_ratings')
          .select('rating')
          .eq('farmer_id', summaryRow.owner_id)
          .eq('rated_by', user.id)
          .maybeSingle();
        if (existingRating && !cancelled) setMyRating(existingRating.rating);
      }
    }

    load().catch((err) => {
      // A network call above can reject outright (not just come back
      // with a supabase `error` field) if the device is genuinely
      // offline mid-request. If cache already rendered something this
      // is a silent no-op; if not, stop the spinner instead of hanging.
      console.error('[FieldDetailModal] load failed:', err);
      if (!cancelled) setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [field.id]);

  const handleRate = async (rating) => {
    const { data: { user } } = await supabase.auth.getUser();
    if (!user || !summary) return;
    setMyRating(rating);
    await supabase
      .from('farmer_ratings')
      .upsert({ farmer_id: summary.owner_id, rated_by: user.id, rating }, { onConflict: 'farmer_id,rated_by' });
  };

  // CHANGED: was handleShareCrop(crop) - one (field, crop) pair per tap,
  // producing a separate card per crop (a field with Grass + Munga meant
  // two shares). Now shares the whole field - every current crop - in one
  // card via shareFieldCard, so there's one share action for the field
  // instead of one per crop. currentCrops is computed below; this handler
  // is only ever called once it's non-empty (button is hidden otherwise).
  const handleShareField = async () => {
    if (sharingField) return;
    setSharingField(true);
    try {
      await shareFieldCard(
        { ...field, ownerName: summary?.owner_name, ownerVillage: summary?.owner_village },
        currentCrops
      );
    } catch (err) {
      alert('Could not create share card: ' + err.message);
    } finally {
      setSharingField(false);
    }
  };

  const currentCrops = cropHistory.filter((c) => c.status !== 'harvested');
  const pastCrops = cropHistory.filter((c) => c.status === 'harvested');

  const hasSoilData = [field.soil_n, field.soil_p, field.soil_k, field.soil_ph].some(
    (v) => v !== null && v !== undefined && v !== ''
  );

  const fieldOwnerId = summary?.owner_id ?? field.owner_id;
  const isOwner = !!currentUserId && !!fieldOwnerId && currentUserId === fieldOwnerId;
  const activeCropChat = currentCrops.find((c) => c.id === cropChatId) || null;
  // Hero photo: first current crop's own image, same photo a buyer would
  // see on that crop's card - falls back to a plant emoji, same pattern
  // as Cattle/Service/Pond's hero strips.
  const heroPhoto = currentCrops.find((c) => c.image_url)?.image_url || null;

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 4000,
        background: 'rgba(0,0,0,0.6)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 16,
      }}
      onClick={onClose}
    >
      {/* Fixed 9:16 card shell, matching ServiceDetailModal.jsx /
          CattleDetailModal.jsx / PondDetailModal.jsx: flexShrink:0 hero
          strip, then a scrollable flex:1 body underneath for everything
          else (owner info, crops, soil, history) - however long that
          gets for a given field. Replaces the old absolute-positioned
          close button with the same header-row x used elsewhere. */}
      <div
        className="kb-card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxWidth: 360, aspectRatio: '9 / 16', maxHeight: '85vh',
          display: 'flex', flexDirection: 'column', overflow: 'hidden',
        }}
      >
        <div
          style={{
            flexShrink: 0,
            height: 84,
            background: heroPhoto ? `url(${heroPhoto}) center/cover` : 'var(--color-bg)',
            display: heroPhoto ? 'block' : 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 36,
          }}
        >
          {!heroPhoto && '🌾'}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
        {loading ? (
          <p>Loading…</p>
        ) : (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span className="display-text" style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-navy)' }}>
                {field.name}
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {/* ADDED: single field-level share, replacing the old
                    per-crop share buttons below (see handleShareField).
                    Hidden while crops are still loading / empty - nothing
                    to share yet, same as the per-crop buttons only ever
                    appearing once a crop row existed. */}
                {currentCrops.length > 0 && (
                  <button
                    onClick={handleShareField}
                    disabled={sharingField}
                    aria-label="Share field"
                    title="Share field"
                    style={{ border: 'none', background: 'transparent', fontSize: 18, cursor: sharingField ? 'default' : 'pointer', opacity: sharingField ? 0.5 : 1 }}
                  >
                    {sharingField ? '…' : '📤'}
                  </button>
                )}
                {typeof onToggleLike === 'function' && (
                  <button
                    onClick={() => onToggleLike(field)}
                    aria-label={isLiked ? 'Unlike' : 'Like'}
                    style={{ border: 'none', background: 'transparent', fontSize: 18, cursor: 'pointer' }}
                  >
                    {isLiked ? '❤️' : '🤍'}
                  </button>
                )}
                <button
                  onClick={onClose}
                  aria-label="Close"
                  style={{ border: 'none', background: 'transparent', fontSize: 18, color: 'var(--color-ink)', cursor: 'pointer' }}
                >
                  x
                </button>
              </div>
            </div>

            {/* Structured detail rows - icon + label + value, matching
                ServiceDetailModal's pattern rather than the old
                two-column header layout, so all four modals read the
                same way. */}
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 13 }}>
              {summary?.owner_name && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <span style={{ width: 20, textAlign: 'center' }}>👤</span>
                  <span style={{ color: 'var(--color-muted)' }}>Farmer</span>
                  <span style={{ marginLeft: 'auto', fontWeight: 600, color: 'var(--color-ink)' }}>{summary.owner_name}</span>
                </div>
              )}
              {summary?.owner_village && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <span style={{ width: 20, textAlign: 'center' }}>📍</span>
                  <span style={{ color: 'var(--color-muted)' }}>Village</span>
                  <span style={{ marginLeft: 'auto', fontWeight: 600, color: 'var(--color-ink)' }}>{summary.owner_village}</span>
                </div>
              )}
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <span style={{ width: 20, textAlign: 'center' }}>⭐</span>
                <span style={{ color: 'var(--color-muted)' }}>Rating</span>
                <span style={{ marginLeft: 'auto' }}>
                  <StarRating value={myRating} onRate={handleRate} />
                </span>
              </div>
              {summary?.owner_rating_count > 0 && (
                <div style={{ fontSize: 11, color: 'var(--color-muted)', textAlign: 'right' }}>
                  {summary.owner_avg_rating} avg ({summary.owner_rating_count} rating{summary.owner_rating_count === 1 ? '' : 's'})
                </div>
              )}
            </div>

            {/* Field-owner-level chat - replaces the old direct
                Call/WhatsApp for the farmer as a whole. Not shown to
                the field's own owner, and now waits for ownerCheckDone
                so it doesn't flash-then-hide on first render. */}
            {!isOwner && ownerCheckDone && fieldOwnerId && (
              <button
                type="button"
                onClick={() => setOwnerChatOpen(true)}
                style={{ ...styles.contactButton, width: '100%', background: 'var(--color-navy)', color: '#fff', border: 'none' }}
              >
                💬 Chat with Farmer
              </button>
            )}

            <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 10, marginTop: 4, fontWeight: 700, fontSize: 14 }}>
              {currentCrops.length > 1 ? 'Current crops' : 'Current crop'}
            </div>
            {currentCrops.length === 0 ? (
              <p style={{ color: 'var(--color-muted)', fontSize: 13 }}>No crop currently growing.</p>
            ) : (
              currentCrops.map((crop) => (
                <div key={crop.id} style={{ display: 'flex', gap: 10, padding: '10px 0', borderBottom: '1px solid var(--color-border)' }}>
                  <div style={{ width: 56, height: 56, borderRadius: 8, overflow: 'hidden', flexShrink: 0, background: 'var(--color-bg)' }}>
                    {crop.image_url ? (
                      <img src={crop.image_url} alt={crop.crop_type} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22 }}>🌱</div>
                    )}
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ textTransform: 'capitalize', fontWeight: 600 }}>
                        {crop.crop_type} · {STATUS_LABEL[crop.status] || crop.status}
                      </span>
                      {crop.qc_certificate_url && (
                        <a
                          href={crop.qc_certificate_url}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => e.stopPropagation()}
                          style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-success)', background: 'var(--color-bg)', border: '1px solid var(--color-success)', padding: '2px 6px', borderRadius: 6, textDecoration: 'none' }}
                        >
                          ✓ QC Certified
                        </a>
                      )}
                      {/* Read-only display only - toggling is_organic when
                          creating/editing a crop belongs in AddCropForm.jsx,
                          not here. Assumes crops_marketplace.is_organic
                          exists - confirm/create the column before relying
                          on this. */}
                      {crop.is_organic && (
                        <span
                          style={{ fontSize: 10, fontWeight: 700, color: '#2e7d32', background: 'var(--color-bg)', border: '1px solid #2e7d32', padding: '2px 6px', borderRadius: 6 }}
                        >
                          🌿 Organic
                        </span>
                      )}
                    </div>
                    {crop.harvest_date && (
                      <div style={{ fontSize: 12, color: 'var(--color-muted)' }}>
                        Next expected: {new Date(crop.harvest_date).toLocaleDateString('en-IN')}
                      </div>
                    )}
                    {crop.sowing_date && (
                      <div style={{ fontSize: 12, color: 'var(--color-muted)' }}>
                        Sown: {new Date(crop.sowing_date).toLocaleDateString('en-IN')}
                      </div>
                    )}
                    {crop.expected_yield_kg != null && crop.expected_yield_kg !== '' && (
                      <div style={{ fontSize: 12, color: 'var(--color-muted)' }}>
                        Expected yield: {crop.expected_yield_kg} kg
                      </div>
                    )}
                    {(crop.wholesale_price || crop.retail_price) && (
                      <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-success)', marginTop: 2 }}>
                        {crop.wholesale_price ? `Wholesale ₹${crop.wholesale_price}` : ''}
                        {crop.wholesale_price && crop.retail_price ? ' · ' : ''}
                        {crop.retail_price ? `Retail ₹${crop.retail_price}` : ''}
                      </div>
                    )}
                    {crop.fertilizer_log && (
                      <div style={{ fontSize: 12, color: 'var(--color-muted)', marginTop: 4, whiteSpace: 'pre-wrap' }}>
                        🧪 {crop.fertilizer_log}
                      </div>
                    )}
                    {/* Per-crop chat - replaces the old per-crop direct
                        Call/WhatsApp. Same rule: hidden for the owner,
                        and waits for ownerCheckDone. */}
                    {!isOwner && ownerCheckDone && (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); setCropChatId(crop.id); }}
                        style={{ ...styles.contactButton, flex: 'unset', padding: '4px 10px', fontSize: 12, marginTop: 6, background: 'var(--color-navy)', color: '#fff', border: 'none' }}
                      >
                        💬 Chat about this crop
                      </button>
                    )}
                  </div>
                </div>
              ))
            )}

            {hasSoilData && (
              <div style={{ marginTop: 14 }}>
                <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 6 }}>🌱 Soil Health</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {field.soil_n != null && field.soil_n !== '' && (
                    <NutrientBadge label="N" value={Number(field.soil_n)} rangeKey="soil_n" />
                  )}
                  {field.soil_p != null && field.soil_p !== '' && (
                    <NutrientBadge label="P" value={Number(field.soil_p)} rangeKey="soil_p" />
                  )}
                  {field.soil_k != null && field.soil_k !== '' && (
                    <NutrientBadge label="K" value={Number(field.soil_k)} rangeKey="soil_k" />
                  )}
                  {field.soil_ph != null && field.soil_ph !== '' && (
                    <NutrientBadge label="pH" value={Number(field.soil_ph)} rangeKey="soil_ph" />
                  )}
                </div>
              </div>
            )}

            <div style={{ marginTop: 14, fontWeight: 700, fontSize: 14 }}>Crop history</div>
            {pastCrops.length === 0 ? (
              <p style={{ color: 'var(--color-muted)', fontSize: 13 }}>No past crops recorded.</p>
            ) : (
              pastCrops.map((c) => (
                <div key={c.id} style={{ padding: '8px 0', borderBottom: '1px solid var(--color-border)' }}>
                  <div style={{ textTransform: 'capitalize', fontWeight: 600 }}>
                    {c.crop_type} · {STATUS_LABEL[c.status]}
                  </div>
                  {c.restricted_inputs?.length > 0 && (
                    <div style={{ fontSize: 12, color: 'var(--color-danger)', marginTop: 2 }}>
                      Avoid next: {c.restricted_inputs.join(', ')}
                    </div>
                  )}
                </div>
              ))
            )}
          </>
        )}
        </div>
      </div>

      {ownerChatOpen && (
        <div onClick={(e) => e.stopPropagation()}>
          <ChatModal
            listingType="field"
            listingId={field.id}
            sellerPhone={summary?.owner_whatsapp || summary?.owner_phone || null}
            onClose={() => setOwnerChatOpen(false)}
          />
        </div>
      )}

      {activeCropChat && (
        <div onClick={(e) => e.stopPropagation()}>
          <ChatModal
            listingType="crop"
            listingId={activeCropChat.id}
            sellerPhone={activeCropChat.contact_whatsapp || activeCropChat.contact_phone || null}
            onClose={() => setCropChatId(null)}
          />
        </div>
      )}
    </div>
  );
}

const styles = {
  contactButton: {
    flex: 1,
    textAlign: 'center',
    padding: '8px 0',
    borderRadius: 8,
    border: '1px solid var(--color-border)',
    background: 'var(--color-card)',
    color: 'var(--color-navy)',
    fontWeight: 700,
    fontSize: 13,
    textDecoration: 'none',
  },
};