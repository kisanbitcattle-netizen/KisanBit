// src/components/CattleCard.jsx

import { useState, useEffect, useMemo } from 'react';
import { supabase } from '../../config/supabaseClient';
import { ANIMAL_EMOJI, isSellable } from '../../utils/animalTaxonomy';
import SellPriceModal from './SellPriceModal';
import EditCattleModal from './EditCattleModal';
import TransferOwnershipModal from './TransferOwnershipModal';
import ConfirmModal from '../../shared/ConfirmModal';
import CardHeaderStrip from '../../shared/CardHeaderStrip';
import { parseWkbPoint } from '../../utils/geo';

function timeAgo(isoString) {
  if (!isoString) return 'no data yet';
  const diffMs = Date.now() - new Date(isoString).getTime();
  const sec = Math.floor(diffMs / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  return `${hr}h ago`;
}

function parsePoint(geoJsonPointOrWkbHex) {
  if (!geoJsonPointOrWkbHex) return null;
  // GeoJSON shape, e.g. from a `_geojson` computed column if one exists.
  if (typeof geoJsonPointOrWkbHex === 'object' && Array.isArray(geoJsonPointOrWkbHex.coordinates)) {
    const [lon, lat] = geoJsonPointOrWkbHex.coordinates;
    if (typeof lat === 'number' && typeof lon === 'number') return [lat, lon];
    return null;
  }
  // Raw WKB hex - the actual shape a plain `select geofence_center` returns
  // per PostgREST unless wrapped in ST_AsGeoJSON. Whether a
  // `geofence_center_geojson` computed column exists here has never been
  // confirmed live (unlike `fields.boundary_geojson`, which was), so this
  // WKB fallback is what actually makes zone recentering work for existing
  // geofences until that's checked.
  if (typeof geoJsonPointOrWkbHex === 'string') {
    return parseWkbPoint(geoJsonPointOrWkbHex);
  }
  return null;
}

// ADDED: last-ping LoRa signal strength -> a farmer-readable label + bar
// icon. RSSI (dBm) is the primary signal, thresholds are standard LoRa
// ballparks (not tuned against this project's real collar/gateway range
// data yet - flag if field testing shows these buckets feel wrong).
// SNR is shown alongside as the raw dB value since it's a secondary/
// harder-to-explain number, not bucketed on its own.
function signalStrengthLabel(rssi) {
  if (rssi == null) return null;
  if (rssi >= -85) return { text: 'Strong', bars: '📶' };
  if (rssi >= -105) return { text: 'OK', bars: '📶' };
  return { text: 'Weak', bars: '📶' };
}

function ageFromBirthDate(birthDate) {
  if (!birthDate) return null;
  const birth = new Date(birthDate);
  if (Number.isNaN(birth.getTime())) return null;
  const diffMs = Date.now() - birth.getTime();
  const years = diffMs / (1000 * 60 * 60 * 24 * 365.25);
  if (years < 1) return `${Math.round(years * 12)}mo`;
  return `${Math.floor(years)}y`;
}

export default function CattleCard({ cattle, onClick, onToggleListing, onChanged, onDeleted, isFarmerView, isLiked, onToggleLike, hideActions = false, baseName = null }) {
  const [isSellModalOpen, setIsSellModalOpen] = useState(false);
  const [isEditOpen, setIsEditOpen] = useState(false);
  const [isTransferOpen, setIsTransferOpen] = useState(false);
  // Delete is now one button that reveals an inline Archive-vs-Delete
  // choice, replacing the two separate danger-zone buttons that used to
  // sit below the primary row.
  const [showDeleteChoice, setShowDeleteChoice] = useState(false);
  const [confirmMode, setConfirmMode] = useState(null); // 'archive' | 'delete' | null
  const [busy, setBusy] = useState(false);
  const [liking, setLiking] = useState(false);
  const [breedingBusy, setBreedingBusy] = useState(false);

  const {
    name,
    animal_type,
    animalType: animalTypeCamel,
    local_image_path,
    localImageUri,
    marketplace_photo_url,
    marketplacePhotoUrl: marketplacePhotoUrlCamel,
    last_updated,
    is_listed_for_sale: isListed,
    sale_price_min,
    salePriceMin: salePriceMinCamel,
    sale_price_max,
    salePriceMax: salePriceMaxCamel,
    collar_id,
    collarId: collarIdCamel,
    base_id,
    baseId: baseIdCamel,
    average_rating,
    averageRating: averageRatingCamel,
    rating_count,
    ratingCount: ratingCountCamel,
    calving_count,
    calvingCount: calvingCountCamel,
    breed,
    govt_inaph_id,
    govtInaphId: govtInaphIdCamel,
    birth_date,
    birthDate: birthDateCamel,
    weight_kg,
    weightKg: weightKgCamel,
    contact_phone,
    contactPhone: contactPhoneCamel,
    contact_whatsapp,
    contactWhatsapp: contactWhatsappCamel,
    qc_certificate_url,
    qcCertificateUrl: qcCertificateUrlCamel,
    is_breeding_ready,
    isBreedingReady: isBreedingReadyCamel,
    live_location: liveLocationRaw,
    liveLocation: liveLocationCamel,
    last_rssi,
    lastRssi: lastRssiCamel,
    last_snr,
    lastSnr: lastSnrCamel,
  } = cattle;

  // Tolerate either raw-DB-row (snake_case, e.g. from a direct
  // supabase.from('cattle').select() elsewhere) or FullMapModal's
  // already-mapped camelCase shape — whichever the caller passes in.
  const animalType = animal_type ?? animalTypeCamel;
  const localImagePath = local_image_path ?? localImageUri;
  const marketplacePhotoUrl = marketplace_photo_url ?? marketplacePhotoUrlCamel;
  const lastUpdated = last_updated;
  const salePriceMin = sale_price_min ?? salePriceMinCamel;
  const salePriceMax = sale_price_max ?? salePriceMaxCamel;
  const collarId = collar_id ?? collarIdCamel;
  const averageRating = average_rating ?? averageRatingCamel;
  const ratingCount = rating_count ?? ratingCountCamel;
  const calvingCount = calving_count ?? calvingCountCamel;
  const govtInaphId = govt_inaph_id ?? govtInaphIdCamel;
  const birthDate = birth_date ?? birthDateCamel;
  const weightKg = weight_kg ?? weightKgCamel;
  const contactPhone = contact_phone ?? contactPhoneCamel;
  const contactWhatsapp = contact_whatsapp ?? contactWhatsappCamel;
  const qcCertificateUrl = qc_certificate_url ?? qcCertificateUrlCamel;
  const isBreedingReady = is_breeding_ready ?? isBreedingReadyCamel ?? false;
  const lastRssi = last_rssi ?? lastRssiCamel;
  const lastSnr = last_snr ?? lastSnrCamel;
  const signal = useMemo(() => signalStrengthLabel(lastRssi), [lastRssi]);
  const animalAge = ageFromBirthDate(birthDate);

  const photoSrc = localImagePath || marketplacePhotoUrl;
  // Last recorded position, for the "Locate" button - reuses the same
  // GeoJSON/WKB-hex tolerant parser geofence_center used to. Hidden
  // entirely (see the button below) if the animal has never reported one.
  const liveLocationPoint = useMemo(
    () => parsePoint(liveLocationRaw) || liveLocationCamel || null,
    [liveLocationRaw, liveLocationCamel]
  );

  const handleSellClick = (e) => {
    e.stopPropagation();
    if (isListed) {
      onToggleListing(cattle, null);
    } else {
      setIsSellModalOpen(true);
    }
  };

  const handleToggleBreedingReady = async (e) => {
    e.stopPropagation();
    if (breedingBusy) return;
    setBreedingBusy(true);
    const next = !isBreedingReady;
    const { error } = await supabase
      .from('cattle')
      .update({ is_breeding_ready: next, updated_at: new Date().toISOString() })
      .eq('id', cattle.id);
    setBreedingBusy(false);
    if (error) {
      window.alert(`Update avvaledu: ${error.message}`);
      return;
    }
    // Refetch parent state instead of just flipping local state - same
    // reasoning as the Zones onSaved fix: without this, reopening
    // anything that reads cattle.is_breeding_ready (CattleDetailModal,
    // FullMapModal's breeding badge) would show the stale pre-toggle
    // value until an unrelated refresh happened to occur.
    onChanged?.();
  };

  const handleLikeClick = async (e) => {
    e.stopPropagation();
    if (liking || typeof onToggleLike !== 'function') return;
    setLiking(true);
    await onToggleLike(cattle);
    setLiking(false);
  };

  const handleArchive = async () => {
    setBusy(true);
    const { error } = await supabase.from('cattle').update({ is_archived: true }).eq('id', cattle.id);
    setBusy(false);
    if (error) {
      // Keep the confirm modal open so the user sees the failure and can
      // retry, instead of silently closing as if it worked.
      window.alert(`Archive avvaledu: ${error.message}`);
      return;
    }
    setConfirmMode(null);
    onChanged?.();
  };

  const handleHardDelete = async () => {
    setBusy(true);
    const { error } = await supabase.from('cattle').delete().eq('id', cattle.id);
    setBusy(false);
    if (error) {
      window.alert(`Delete avvaledu: ${error.message}`);
      return;
    }
    setConfirmMode(null);
    // BUG FIX: don't rely on onChanged() -> loadAll() (cache-first) or on
    // a realtime DELETE echo to clean this row out of the parent's local
    // state + offlineCache. A .delete().eq('id', ...) call reports NO
    // error even when zero rows matched (e.g. this exact row was already
    // hard-deleted once before, and this card is showing a stale/cached
    // copy of it) - in that case nothing actually changes in Postgres,
    // so Postgres never emits a realtime DELETE event, so a
    // cache-purge that only lives inside the realtime DELETE handler
    // never runs, and the ghost survives forever. Calling onDeleted
    // here removes it from state/cache unconditionally, straight from
    // the action that the user themself just took, instead of waiting
    // on a round-trip signal that may never arrive for an
    // already-deleted row.
    onDeleted?.(cattle.id);
  };

  // Header strip (List/Edit/Delete on a navy band, matching CropCard's
  // green header) replaces this card's own avatar for the farmer view -
  // the avatar moves up into the strip instead of sitting inline with
  // the name. Buyer view (or hideActions) never renders the strip, so
  // it keeps the original inline avatar so nothing there changes.
  const showHeaderStrip = isFarmerView && !hideActions;

  return (
    <div
      className="kb-card"
      onClick={onClick}
      style={{ overflow: 'hidden', cursor: onClick ? 'pointer' : 'default' }}
    >
      {showHeaderStrip && (
        <CardHeaderStrip
          color="var(--color-navy)"
          avatarSrc={photoSrc}
          avatarAlt={name}
          avatarFallback={ANIMAL_EMOJI[animalType] || '?'}
          toggle={onToggleListing && isSellable(animalType) ? {
            isListed,
            onClick: handleSellClick,
          } : undefined}
          onEdit={() => setIsEditOpen(true)}
          del={{ mode: 'trigger', onClick: () => setShowDeleteChoice((v) => !v) }}
        />
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 14 }}>
      <div style={{ display: 'flex', gap: 14, alignItems: 'center' }}>
        {!showHeaderStrip && (
          <div
            style={{
              width: 56, height: 56, borderRadius: '50%', flexShrink: 0, overflow: 'hidden',
              background: 'var(--color-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 26, border: '1px solid var(--color-border)',
            }}
          >
            {photoSrc ? (
              <img src={photoSrc} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
            ) : (
              ANIMAL_EMOJI[animalType] || '?'
            )}
          </div>
        )}

        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span style={{ fontWeight: 700, fontSize: 15 }}>{name}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {isListed && salePriceMin != null && (
                <span style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-success)' }}>
                  Rs{salePriceMin} - {salePriceMax}
                </span>
              )}
              {typeof onToggleLike === 'function' && (
                <button
                  onClick={handleLikeClick}
                  aria-label={isLiked ? 'Unlike' : 'Like'}
                  style={{ background: 'none', border: 'none', fontSize: 16, padding: 0, lineHeight: 1 }}
                >
                  {isLiked ? '❤️' : '🤍'}
                </button>
              )}
            </div>
          </div>
          <div style={{ fontSize: 13, color: 'var(--color-muted)', textTransform: 'capitalize' }}>
            {animalType} - updated {timeAgo(lastUpdated)}
            {averageRating != null && ` - \u2605 ${averageRating} (${ratingCount})`}
          </div>
          <div style={{ fontSize: 11, color: 'var(--color-muted)', marginTop: 2, display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            {isFarmerView && baseName && <span>📍 {baseName}</span>}
            {isFarmerView && collarId && <span style={{ fontFamily: 'monospace' }}>Collar: {collarId}</span>}
            {isFarmerView && signal && (
              <span title={lastSnr != null ? `RSSI ${lastRssi} dBm, SNR ${lastSnr} dB` : `RSSI ${lastRssi} dBm`}>
                {signal.bars} {signal.text}
              </span>
            )}
            {calvingCount != null && <span>Calvings: {calvingCount}</span>}
            {breed && <span style={{ textTransform: 'capitalize' }}>{breed}</span>}
            {animalAge && <span>Age: {animalAge}</span>}
            {weightKg != null && <span>{weightKg}kg</span>}
            {govtInaphId && <span>INAPH: {govtInaphId}</span>}
            {qcCertificateUrl && (
              <a
                href={qcCertificateUrl}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                style={{ fontWeight: 700, color: 'var(--color-success, #1b5e20)', background: 'var(--color-success-container, #e6f4ea)', padding: '2px 6px', borderRadius: 6, textDecoration: 'none' }}
              >
                ✓ QC Certified
              </a>
            )}
          </div>
          {(contactPhone || contactWhatsapp) && (
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              {contactPhone && (
                <a
                  href={`tel:${contactPhone}`}
                  onClick={(e) => e.stopPropagation()}
                  style={{ fontSize: 11, fontWeight: 700, color: 'var(--color-navy)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '3px 8px', textDecoration: 'none' }}
                >
                  📞 Call
                </a>
              )}
              <a
                href={`https://wa.me/${(contactWhatsapp || contactPhone || '').replace(/\D/g, '')}`}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                style={{ fontSize: 11, fontWeight: 700, color: '#fff', background: '#25D366', borderRadius: 8, padding: '3px 8px', textDecoration: 'none' }}
              >
                💬 WhatsApp
              </a>
            </div>
          )}
        </div>
      </div>

      {showHeaderStrip && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {/* Inline Archive-vs-Delete choice - replaces the old separate
              Archive + Delete buttons. Delete is now one button; tapping it
              reveals this choice instead of jumping straight to a confirm
              dialog, so a farmer can't land on the irreversible option by
              a single accidental tap. */}
          {showDeleteChoice && (
            <div
              onClick={(e) => e.stopPropagation()}
              style={{
                display: 'flex', gap: 8, padding: 8, borderRadius: 10,
                background: 'var(--color-bg)', border: '1px solid var(--color-border)',
              }}
            >
              <button
                onClick={() => { setShowDeleteChoice(false); setConfirmMode('archive'); }}
                style={{ ...primaryBtnStyle('var(--color-muted)'), flex: 1 }}
              >
                🗄 Archive
              </button>
              <button
                onClick={() => { setShowDeleteChoice(false); setConfirmMode('delete'); }}
                style={{ ...primaryBtnStyle('var(--color-danger)'), flex: 1 }}
              >
                🗑 Delete Permanently
              </button>
            </div>
          )}

          {/* Secondary actions - less frequent than List/Edit/Delete, so
              kept visually quieter and below the header strip. */}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <button onClick={handleToggleBreedingReady} disabled={breedingBusy} style={primaryBtnStyle('var(--color-gold)')}>
              {breedingBusy ? '...' : isBreedingReady ? '💗 Un-mark' : '💗 Breed Ready'}
            </button>
            <button onClick={(e) => { e.stopPropagation(); setIsTransferOpen(true); }} style={primaryBtnStyle('var(--color-navy)')}>
              ↔ Transfer
            </button>
            {liveLocationPoint && (
              <a
                href={`https://www.google.com/maps/search/?api=1&query=${liveLocationPoint[0]},${liveLocationPoint[1]}`}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
                style={{ ...primaryBtnStyle('var(--color-navy)'), textDecoration: 'none', display: 'inline-block' }}
              >
                📡 Locate
              </a>
            )}
          </div>
        </div>
      )}
      </div>

      {isSellModalOpen && (
        <SellPriceModal
          cattleName={name}
          // FIX: SellPriceModal has supported initialMin/initialMax for a
          // while (see its own header comment) so a re-listing farmer sees
          // their previous price range instead of blank fields - but this
          // call site never actually passed them. Wired now.
          initialMin={salePriceMin}
          initialMax={salePriceMax}
          onCancel={() => setIsSellModalOpen(false)}
          onConfirm={({ min, max }) => {
            onToggleListing(cattle, { min, max });
            setIsSellModalOpen(false);
          }}
        />
      )}

      {isEditOpen && (
        <EditCattleModal
          cattle={cattle}
          onCancel={() => setIsEditOpen(false)}
          onSaved={() => { setIsEditOpen(false); onChanged?.(); }}
        />
      )}

      {isTransferOpen && (
        <TransferOwnershipModal
          cattle={cattle}
          onCancel={() => setIsTransferOpen(false)}
          onSent={() => { setIsTransferOpen(false); onChanged?.(); }}
        />
      )}

      {confirmMode === 'archive' && (
        <ConfirmModal
          title="Archive Cattle"
          message={`${name} ni archive cheddama? Idi reversible - data DB lo untundi, list lo matrame kanipinchadu.`}
          confirmLabel={busy ? 'Archiving...' : 'Archive'}
          severity="normal"
          onConfirm={handleArchive}
          onCancel={() => setConfirmMode(null)}
        />
      )}

      {confirmMode === 'delete' && (
        <ConfirmModal
          title="Delete Permanently"
          message={`Delete ${name} permanently? This cannot be undone - all records (location history, health records, ratings) will be deleted.`}
          confirmLabel={busy ? 'Deleting...' : 'Delete Permanently'}
          severity="danger"
          requireTypedConfirmation={name}
          onConfirm={handleHardDelete}
          onCancel={() => setConfirmMode(null)}
        />
      )}
    </div>
  );
}

function primaryBtnStyle(color) {
  return {
    fontSize: 12, fontWeight: 700, padding: '7px 12px', borderRadius: 20,
    border: `1px solid ${color}`, background: 'transparent', color,
  };
}