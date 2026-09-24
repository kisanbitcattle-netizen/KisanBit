// src/components/PondDetailModal.jsx
//
// Read-only detail view for a tapped Pond (polygon or marker) on
// FullMapModal.jsx, mirroring CattleDetailModal.jsx/ServiceDetailModal.jsx's
// shape. Unlike those, a Pond can have MULTIPLE sellable children (fish
// stock entries, one per species/batch) - same relationship a Field has
// to its Crops - so each listed fish entry gets its own "Chat with
// Seller" button (ChatModal listingType="fish", listingId=<fish
// stock row id>), not one chat for the whole pond.
//
// Owner contact (phone/WhatsApp) isn't stored directly on ponds or
// pond_fish_stock as a fallback, so it's fetched from `users` by
// owner_id, same pattern as CattleDetailModal's loadOwnerContact - but
// the pond's own contact_phone/contact_whatsapp (if present) win over
// that, same override pattern CattleDetailModal uses for its own
// contact fields.
//
// Expects a `pond` object shaped like FullMapModal.jsx's loadPonds()
// return value: { id, ownerId, pondName, waterSource, notes,
// positions, centroid, fishStock: [...] }.
//
// RESTYLED to match ServiceDetailModal.jsx's fixed 9:16 card shell
// (flexShrink:0 hero strip + scrollable flex:1 body) and its
// icon+label+value detail-row pattern, so all four detail modals
// (Cattle/Field/Pond/Service) now read the same way.
//
// ASSUMPTIONS / OPEN ITEMS (flag before shipping):
// 1. New fields read below - image_url, area_acres, contact_phone/
//    whatsapp, youtube/instagram/facebook_url on the pond itself, and
//    water_type/ph/temperature_c/dissolved_oxygen_mg_l/
//    expected_harvest_date/image_url/contact_phone/contact_whatsapp
//    on each fish-stock row - all exist in the confirmed schema, but
//    it's UNCONFIRMED whether FullMapModal.jsx's loadPonds() actually
//    selects and maps all of them onto the pond/fishStock objects this
//    component receives. Every section that reads them is conditional
//    (renders nothing if the field is undefined), so this is safe
//    either way - but loadPonds() needs to be checked/updated next
//    session for the new pond-level fields (fish-stock-level ones were
//    likely already being passed through, since photo_url/water_type
//    etc. were already part of pond_fish_stock's known columns).
// 2. Pond-level fields are read tolerating either casing
//    (pond.imageUrl ?? pond.image_url), matching the existing
//    ownerId/baseId pattern elsewhere in the codebase, in case
//    loadPonds() maps them to camelCase like it does for the fields
//    already in the docstring above.
// 3. BrandIcon/BRAND_ICON_PATHS below are duplicated from
//    ServiceDetailModal.jsx as-is (same three brands, same paths) since
//    no shared icon module was in this conversation to import from
//    instead. If one gets extracted later, swap this block out for an
//    import rather than keep two copies in sync by hand.
// 4. Per-fish chat now prefers that fish-stock row's own
//    contact_phone/contact_whatsapp over the pond owner's, mirroring
//    how CattleDetailModal's cattle-level contact fields win over the
//    owner's - useful if a family pond is worked by more than one
//    person and each batch has its own contact.

import { useEffect, useState } from 'react';
import { supabase } from '../../config/supabaseClient';
import ChatModal from '../../components/ChatModal';
import { sharePondCard } from '../../utils/shareCard';

const BRAND_ICON_PATHS = {
  youtube: 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
  instagram: 'M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077',
  facebook: 'M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z',
};

function BrandIcon({ brand, size = 26 }) {
  const glyph = Math.round(size * 0.55);
  return (
    <svg viewBox="0 0 24 24" width={glyph} height={glyph} fill="#fff" aria-hidden="true">
      <path d={BRAND_ICON_PATHS[brand]} />
    </svg>
  );
}

export default function PondDetailModal({ pond, onClose }) {
  const { id, ownerId, pondName, waterSource, notes, fishStock = [] } = pond;

  // Not confirmed present on the `pond` object yet - see ASSUMPTIONS
  // note #1 at top of file. Every render below is conditional on these,
  // so it's a silent no-op until loadPonds() is confirmed to pass them.
  const imageUrl = pond.imageUrl ?? pond.image_url ?? null;
  const areaAcres = pond.areaAcres ?? pond.area_acres ?? null;
  const pondContactPhone = pond.contactPhone ?? pond.contact_phone ?? null;
  const pondContactWhatsapp = pond.contactWhatsapp ?? pond.contact_whatsapp ?? null;
  const youtubeUrl = pond.youtubeUrl ?? pond.youtube_url ?? null;
  const instagramUrl = pond.instagramUrl ?? pond.instagram_url ?? null;
  const facebookUrl = pond.facebookUrl ?? pond.facebook_url ?? null;

  const [currentUserId, setCurrentUserId] = useState(null);
  const [ownerContact, setOwnerContact] = useState(null);
  const [chatFish, setChatFish] = useState(null); // the specific fish-stock row being chatted about (plus its resolved seller phone)
  // CHANGED: was per-fish `sharingFishId` (one share button per fish
  // entry, gating just that entry's button). Now one pond-level share
  // covers every listed fish at once, so a single boolean is enough.
  const [sharingPond, setSharingPond] = useState(false);

  const isOwner = !!currentUserId && !!ownerId && currentUserId === ownerId;
  // Pond's own contact fields win over the owner's account-level phone,
  // same override pattern CattleDetailModal uses for cattleContactPhone.
  const chatSellerPhone = pondContactWhatsapp || pondContactPhone || ownerContact?.phone || null;

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getUser().then(({ data }) => {
      if (!cancelled) setCurrentUserId(data?.user?.id ?? null);
    });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!ownerId) return;
    let cancelled = false;
    async function loadOwnerContact() {
      const { data } = await supabase
        .from('users')
        .select('phone, full_name')
        .eq('id', ownerId)
        .maybeSingle();
      if (data && !cancelled) setOwnerContact(data);
    }
    loadOwnerContact();
    return () => { cancelled = true; };
  }, [ownerId]);

  const listedFish = fishStock.filter((f) => f.is_listed_for_sale);

  // CHANGED: was handleShareFish(f) - one (pond, fish) pair per tap. Now
  // shares the whole pond - every listed fish - in one card via
  // sharePondCard, mirroring FieldDetailModal's handleShareField fix.
  async function handleSharePond() {
    if (sharingPond) return;
    setSharingPond(true);
    try {
      await sharePondCard({ pondName, waterSource }, listedFish);
    } catch (_) {
      // best-effort — e.g. offline, share sheet dismissed, or Capacitor
      // plugins unavailable in a plain browser tab; nothing to recover
    } finally {
      setSharingPond(false);
    }
  }

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 4500, background: 'rgba(20,24,40,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
      onClick={onClose}
    >
      {/* Fixed 9:16 card shell, matching ServiceDetailModal.jsx /
          CattleDetailModal.jsx / FieldDetailModal.jsx: flexShrink:0 hero
          strip, then a scrollable flex:1 body for pond details + the
          (possibly long) fish-stock list underneath. */}
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
            background: imageUrl ? `url(${imageUrl}) center/cover` : 'var(--color-bg)',
            display: imageUrl ? 'block' : 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 36,
          }}
        >
          {!imageUrl && '🐟'}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span className="display-text" style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-navy)' }}>
              {pondName}
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {/* ADDED: single pond-level share, replacing the old
                  per-fish share buttons below (see handleSharePond).
                  Hidden when nothing's listed - nothing to share yet. */}
              {listedFish.length > 0 && (
                <button
                  onClick={handleSharePond}
                  disabled={sharingPond}
                  aria-label="Share pond"
                  title="Share pond"
                  style={{ border: 'none', background: 'transparent', fontSize: 18, cursor: sharingPond ? 'default' : 'pointer', opacity: sharingPond ? 0.5 : 1 }}
                >
                  {sharingPond ? '…' : '📤'}
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
              ServiceDetailModal's pattern. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 13 }}>
            {waterSource && (
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ width: 20, textAlign: 'center' }}>💧</span>
                <span style={{ color: 'var(--color-muted)' }}>Water source</span>
                <span style={{ marginLeft: 'auto', fontWeight: 600, color: 'var(--color-ink)' }}>{waterSource}</span>
              </div>
            )}
            {areaAcres != null && (
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ width: 20, textAlign: 'center' }}>📐</span>
                <span style={{ color: 'var(--color-muted)' }}>Area</span>
                <span style={{ marginLeft: 'auto', fontWeight: 600, color: 'var(--color-ink)' }}>{areaAcres} acres</span>
              </div>
            )}
          </div>

          {notes && (
            <div style={{ fontSize: 13, color: 'var(--color-ink)', lineHeight: 1.5 }}>{notes}</div>
          )}

          {/* Connect with Us - same icon-only social box as
              ServiceDetailModal, shown whenever the pond has any of the
              three links (see ASSUMPTIONS #1/#2 above re: whether
              loadPonds() actually passes these yet). */}
          {(youtubeUrl || instagramUrl || facebookUrl) && (
            <div style={{
              border: '1px solid var(--color-border)', borderRadius: 10, padding: '8px 14px',
              display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6,
              width: 'fit-content', maxWidth: '100%', margin: '0 auto',
            }}>
              <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--color-muted)', letterSpacing: 0.3 }}>
                CONNECT WITH US
              </span>
              <div style={{ display: 'flex', gap: 14 }}>
                {youtubeUrl && (
                  <a href={youtubeUrl} target="_blank" rel="noreferrer" style={{ textDecoration: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                    <span style={{ width: 26, height: 26, borderRadius: '50%', background: '#FF0000', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <BrandIcon brand="youtube" size={26} />
                    </span>
                    <span style={{ fontSize: 9, color: 'var(--color-muted)' }}>YouTube</span>
                  </a>
                )}
                {instagramUrl && (
                  <a href={instagramUrl} target="_blank" rel="noreferrer" style={{ textDecoration: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                    <span style={{ width: 26, height: 26, borderRadius: '50%', background: '#E1306C', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <BrandIcon brand="instagram" size={26} />
                    </span>
                    <span style={{ fontSize: 9, color: 'var(--color-muted)' }}>Instagram</span>
                  </a>
                )}
                {facebookUrl && (
                  <a href={facebookUrl} target="_blank" rel="noreferrer" style={{ textDecoration: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                    <span style={{ width: 26, height: 26, borderRadius: '50%', background: '#1877F2', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <BrandIcon brand="facebook" size={26} />
                    </span>
                    <span style={{ fontSize: 9, color: 'var(--color-muted)' }}>Facebook</span>
                  </a>
                )}
              </div>
            </div>
          )}

          <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 10, marginTop: 4 }}>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-navy)', marginBottom: 8 }}>
              {isOwner ? 'Fish Stock' : 'Available Fish'}
            </div>

            {/* Owner sees every entry (listed or not, since it's their
                own inventory); a buyer only ever sees listed ones - RLS
                already enforces this server-side via
                pond_fish_stock_public_select_listed, this filter is
                just the matching client-side display rule. */}
            {(isOwner ? fishStock : listedFish).length === 0 && (
              <p style={{ fontSize: 13, color: 'var(--color-muted)' }}>
                {isOwner ? 'No fish stock recorded yet.' : 'Nothing listed for sale right now.'}
              </p>
            )}

            {(isOwner ? fishStock : listedFish).map((f) => {
              // Fish-stock-level contact wins over the pond/owner's, same
              // per-listing override pattern used elsewhere (see
              // ASSUMPTIONS #4 above).
              const fishSellerPhone = f.contact_whatsapp || f.contact_phone || chatSellerPhone;
              return (
                <div
                  key={f.id}
                  style={{
                    display: 'flex', gap: 10, padding: '8px 0', borderBottom: '1px solid var(--color-border)',
                  }}
                >
                  <div style={{ width: 44, height: 44, borderRadius: 8, overflow: 'hidden', flexShrink: 0, background: 'var(--color-bg)' }}>
                    {f.image_url ? (
                      <img src={f.image_url} alt={f.fish_species} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                    ) : (
                      <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 18 }}>🐟</div>
                    )}
                  </div>

                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <div style={{ fontSize: 13, fontWeight: 600, color: 'var(--color-ink)' }}>
                        {f.fish_species}
                        {f.quantity != null ? ` · ${f.quantity}` : ''}
                      </div>

                      {f.is_listed_for_sale && !isOwner && (
                        <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                          <button
                            type="button"
                            onClick={() => setChatFish({ ...f, _sellerPhone: fishSellerPhone })}
                            style={{
                              padding: '6px 10px', borderRadius: 8, border: 'none', background: 'var(--color-navy)',
                              color: '#fff', fontWeight: 700, fontSize: 12, cursor: 'pointer', flexShrink: 0,
                            }}
                          >
                            💬 Chat
                          </button>
                        </div>
                      )}
                    </div>

                    {f.is_listed_for_sale && f.price_per_kg != null && (
                      <div style={{ fontSize: 12, color: 'var(--color-success)', fontWeight: 700 }}>
                        ₹{f.price_per_kg}/kg
                      </div>
                    )}

                    {/* Per-batch water-quality/context chips - present if
                        loadPonds() passes them through on each fish-stock
                        row (see ASSUMPTIONS #1). Open item in the
                        handover: unresolved whether these should instead
                        live on the pond record itself rather than
                        per-batch - kept here since that's where the
                        schema currently has them. */}
                    {(f.water_type || f.ph != null || f.temperature_c != null || f.dissolved_oxygen_mg_l != null || f.expected_harvest_date) && (
                      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 4 }}>
                        {f.water_type && (
                          <span style={{ fontSize: 10, color: 'var(--color-muted)' }}>💧 {f.water_type}</span>
                        )}
                        {f.ph != null && (
                          <span style={{ fontSize: 10, color: 'var(--color-muted)' }}>⚗️ pH {f.ph}</span>
                        )}
                        {f.temperature_c != null && (
                          <span style={{ fontSize: 10, color: 'var(--color-muted)' }}>🌡️ {f.temperature_c}°C</span>
                        )}
                        {f.dissolved_oxygen_mg_l != null && (
                          <span style={{ fontSize: 10, color: 'var(--color-muted)' }}>🫧 {f.dissolved_oxygen_mg_l} mg/L O₂</span>
                        )}
                        {f.expected_harvest_date && (
                          <span style={{ fontSize: 10, color: 'var(--color-muted)' }}>📅 Harvest {new Date(f.expected_harvest_date).toLocaleDateString('en-IN')}</span>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {chatFish && (
        <div onClick={(e) => e.stopPropagation()}>
          <ChatModal
            listingType="fish"
            listingId={chatFish.id}
            sellerPhone={chatFish._sellerPhone ?? chatSellerPhone}
            onClose={() => setChatFish(null)}
          />
        </div>
      )}
    </div>
  );
}