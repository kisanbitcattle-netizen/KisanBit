// src/components/ServiceDetailModal.jsx
//
// Read-only, shareable detail view for a tapped Service marker on
// FullMapModal.jsx. This file did not previously exist correctly —
// the path was occupied by AddServiceForm.jsx's actual content (its
// own header comment confirms this), which is why tapping a service
// pin showed the Add/Edit form instead of a Cattle/Field-style detail
// card. Move that content to its correct path,
// src/components/AddServiceForm.jsx, alongside dropping this file in.
//
// Mirrors CattleDetailModal.jsx's structure (hero photo, owner check,
// Chat button gated on ownerCheckDone, share button) with the
// service-specific fields FullMapModal.jsx's loadServices() actually
// hands to this component: id, ownerId, serviceType, serviceName,
// description, priceAmount, priceUnit, placeName, contactPhone,
// contactWhatsapp, photoUrl, isAvailable.
//
// ASSUMPTIONS (flag before shipping):
// 1. Share: CattleDetailModal.jsx calls shareCattleCard from
//    utils/shareCard.js, which wasn't in this conversation to mirror
//    exactly (it likely renders a branded image card). Rather than
//    guess its internals, this uses a simpler Web Share API call with
//    a clipboard-copy fallback — same end result (share a link/text),
//    less polished than a rendered card. If a shareServiceCard
//    equivalent gets added to utils/shareCard.js later, swap the
//    handleShare body below to call it instead.
// 2. Likes: not wired — FullMapModal renders this without
//    isLiked/onToggleLike props (services have no like concept in the
//    loadServices select), so isLikeable naturally stays false, same
//    conditional pattern as CattleDetailModal.
// 3. Availability toggle: added an owner-only "Mark Unavailable/
//    Available" button writing is_available directly, mirroring
//    CattleDetailModal's isOwner-gated breeding-ready toggle. Not
//    explicitly requested — flag if not wanted.

import { useEffect, useState } from 'react';
import { supabase } from '../config/supabaseClient';
import { SERVICE_TYPES } from './AddServiceForm';
import ChatModal from './ChatModal';
import { shareServiceCard } from '../utils/shareCard';

// Official brand marks (path data from the `simple-icons` package) drawn
// small and crisp instead of emoji (▶️📸👍), which render inconsistently
// across devices/fonts and look out of place next to real logos.
const BRAND_ICON_PATHS = {
  youtube: 'M23.498 6.186a3.016 3.016 0 0 0-2.122-2.136C19.505 3.545 12 3.545 12 3.545s-7.505 0-9.377.505A3.017 3.017 0 0 0 .502 6.186C0 8.07 0 12 0 12s0 3.93.502 5.814a3.016 3.016 0 0 0 2.122 2.136c1.871.505 9.376.505 9.376.505s7.505 0 9.377-.505a3.015 3.015 0 0 0 2.122-2.136C24 15.93 24 12 24 12s0-3.93-.502-5.814zM9.545 15.568V8.432L15.818 12l-6.273 3.568z',
  instagram: 'M7.0301.084c-1.2768.0602-2.1487.264-2.911.5634-.7888.3075-1.4575.72-2.1228 1.3877-.6652.6677-1.075 1.3368-1.3802 2.127-.2954.7638-.4956 1.6365-.552 2.914-.0564 1.2775-.0689 1.6882-.0626 4.947.0062 3.2586.0206 3.6671.0825 4.9473.061 1.2765.264 2.1482.5635 2.9107.308.7889.72 1.4573 1.388 2.1228.6679.6655 1.3365 1.0743 2.1285 1.38.7632.295 1.6361.4961 2.9134.552 1.2773.056 1.6884.069 4.9462.0627 3.2578-.0062 3.668-.0207 4.9478-.0814 1.28-.0607 2.147-.2652 2.9098-.5633.7889-.3086 1.4578-.72 2.1228-1.3881.665-.6682 1.0745-1.3378 1.3795-2.1284.2957-.7632.4966-1.636.552-2.9124.056-1.2809.0692-1.6898.063-4.948-.0063-3.2583-.021-3.6668-.0817-4.9465-.0607-1.2797-.264-2.1487-.5633-2.9117-.3084-.7889-.72-1.4568-1.3876-2.1228C21.2982 1.33 20.628.9208 19.8378.6165 19.074.321 18.2017.1197 16.9244.0645 15.6471.0093 15.236-.005 11.977.0014 8.718.0076 8.31.0215 7.0301.0839m.1402 21.6932c-1.17-.0509-1.8053-.2453-2.2287-.408-.5606-.216-.96-.4771-1.3819-.895-.422-.4178-.6811-.8186-.9-1.378-.1644-.4234-.3624-1.058-.4171-2.228-.0595-1.2645-.072-1.6442-.079-4.848-.007-3.2037.0053-3.583.0607-4.848.05-1.169.2456-1.805.408-2.2282.216-.5613.4762-.96.895-1.3816.4188-.4217.8184-.6814 1.3783-.9003.423-.1651 1.0575-.3614 2.227-.4171 1.2655-.06 1.6447-.072 4.848-.079 3.2033-.007 3.5835.005 4.8495.0608 1.169.0508 1.8053.2445 2.228.408.5608.216.96.4754 1.3816.895.4217.4194.6816.8176.9005 1.3787.1653.4217.3617 1.056.4169 2.2263.0602 1.2655.0739 1.645.0796 4.848.0058 3.203-.0055 3.5834-.061 4.848-.051 1.17-.245 1.8055-.408 2.2294-.216.5604-.4763.96-.8954 1.3814-.419.4215-.8181.6811-1.3783.9-.4224.1649-1.0577.3617-2.2262.4174-1.2656.0595-1.6448.072-4.8493.079-3.2045.007-3.5825-.006-4.848-.0608M16.953 5.5864A1.44 1.44 0 1 0 18.39 4.144a1.44 1.44 0 0 0-1.437 1.4424M5.8385 12.012c.0067 3.4032 2.7706 6.1557 6.173 6.1493 3.4026-.0065 6.157-2.7701 6.1506-6.1733-.0065-3.4032-2.771-6.1565-6.174-6.1498-3.403.0067-6.156 2.771-6.1496 6.1738M8 12.0077a4 4 0 1 1 4.008 3.9921A3.9996 3.9996 0 0 1 8 12.0077',
  facebook: 'M9.101 23.691v-7.98H6.627v-3.667h2.474v-1.58c0-4.085 1.848-5.978 5.858-5.978.401 0 .955.042 1.468.103a8.68 8.68 0 0 1 1.141.195v3.325a8.623 8.623 0 0 0-.653-.036 26.805 26.805 0 0 0-.733-.009c-.707 0-1.259.096-1.675.309a1.686 1.686 0 0 0-.679.622c-.258.42-.374.995-.374 1.752v1.297h3.919l-.386 2.103-.287 1.564h-3.246v8.245C19.396 23.238 24 18.179 24 12.044c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.628 3.874 10.35 9.101 11.647Z',
};

// size = circle diameter in px; the glyph itself is drawn at ~55% of that.
function BrandIcon({ brand, size = 26 }) {
  const glyph = Math.round(size * 0.55);
  return (
    <svg viewBox="0 0 24 24" width={glyph} height={glyph} fill="#fff" aria-hidden="true">
      <path d={BRAND_ICON_PATHS[brand]} />
    </svg>
  );
}

export default function ServiceDetailModal({ service, onClose, isLiked, onToggleLike }) {
  const {
    id,
    ownerId,
    ownerName,
    serviceType,
    serviceName,
    equipmentModel,
    description,
    priceAmount,
    priceUnit,
    placeName,
    contactPhone,
    contactWhatsapp,
    showContactPublicly,
    youtubeUrl,
    instagramUrl,
    facebookUrl,
    photoUrl,
    isAvailable: initialIsAvailable,
  } = service;

  const [currentUserId, setCurrentUserId] = useState(null);
  const [ownerCheckDone, setOwnerCheckDone] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [liking, setLiking] = useState(false);
  const [isAvailable] = useState(!!initialIsAvailable);
  const [ratings, setRatings] = useState([]);
  const [ratingsLoaded, setRatingsLoaded] = useState(false);
  const [myRating, setMyRating] = useState(0);
  const [ratingBusy, setRatingBusy] = useState(false);

  const isOwner = !!currentUserId && !!ownerId && currentUserId === ownerId;
  const isLikeable = typeof onToggleLike === 'function';
  const chatSellerPhone = contactWhatsapp || contactPhone || null;

  const handleLikeClick = async () => {
    if (liking || !isLikeable) return;
    setLiking(true);
    await onToggleLike(service);
    setLiking(false);
  };
  const typeInfo = SERVICE_TYPES.find((t) => t.key === serviceType);
  const avgRating = ratings.length
    ? ratings.reduce((sum, r) => sum + r.rating, 0) / ratings.length
    : null;

  useEffect(() => {
    let cancelled = false;
    supabase.auth.getUser().then(({ data }) => {
      if (!cancelled) {
        setCurrentUserId(data?.user?.id ?? null);
        setOwnerCheckDone(true);
      }
    });
    return () => { cancelled = true; };
  }, []);

  // Ratings - public read, mirrors the existing cattle_ratings pattern.
  // Loaded independently of the owner check so the average/count shows
  // immediately even before we know who's viewing.
  useEffect(() => {
    let cancelled = false;
    supabase
      .from('service_ratings')
      .select('rater_id, rating, comment')
      .eq('service_id', id)
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error) {
          console.error('[ServiceDetailModal] ratings fetch failed:', error.message);
          setRatingsLoaded(true);
          return;
        }
        setRatings(data || []);
        setRatingsLoaded(true);
      });
    return () => { cancelled = true; };
  }, [id]);

  // Once both the ratings list and currentUserId are in, pre-fill the
  // star picker with the viewer's own existing rating (if any) so
  // re-opening the card shows what they already gave, not a blank picker.
  useEffect(() => {
    if (!ratingsLoaded || !currentUserId) return;
    const mine = ratings.find((r) => r.rater_id === currentUserId);
    if (mine) setMyRating(mine.rating);
  }, [ratingsLoaded, currentUserId, ratings]);

  const handleRate = async (stars) => {
    if (ratingBusy || isOwner || !currentUserId) return;
    setRatingBusy(true);
    setMyRating(stars);
    const { error } = await supabase
      .from('service_ratings')
      .upsert(
        { service_id: id, rater_id: currentUserId, rating: stars },
        { onConflict: 'service_id,rater_id' }
      );
    setRatingBusy(false);
    if (error) {
      alert('Could not save rating: ' + error.message);
      return;
    }
    setRatings((prev) => {
      const others = prev.filter((r) => r.rater_id !== currentUserId);
      return [...others, { rater_id: currentUserId, rating: stars }];
    });
  };

  const handleShare = async () => {
    if (sharing) return;
    setSharing(true);
    try {
      await shareServiceCard({
        serviceName,
        typeLabel: typeInfo?.label || serviceType,
        equipmentModel,
        description,
        priceAmount,
        priceUnit,
        placeName,
        photoUrl,
      });
    } catch (err) {
      // AbortError fires when the user just cancels the native share
      // sheet — not a real failure, don't show an error for it.
      if (err?.name !== 'AbortError') {
        alert('Could not share: ' + err.message);
      }
    } finally {
      setSharing(false);
    }
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 4500, background: 'rgba(20,24,40,0.45)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
      onClick={onClose}
    >
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
            background: photoUrl ? `url(${photoUrl}) center/cover` : 'var(--color-bg)',
            display: photoUrl ? 'block' : 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 36,
          }}
        >
          {!photoUrl && (typeInfo?.emoji || '🧰')}
        </div>

        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 8 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
            <span className="display-text" style={{ fontSize: 20, fontWeight: 700, color: 'var(--color-navy)' }}>{serviceName}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {isLikeable && (
                <button
                  onClick={handleLikeClick}
                  disabled={liking}
                  aria-label={isLiked ? 'Unlike' : 'Like'}
                  style={{ border: 'none', background: 'transparent', fontSize: 18, cursor: 'pointer' }}
                >
                  {isLiked ? '❤️' : '🤍'}
                </button>
              )}
              <button
                onClick={handleShare}
                disabled={sharing}
                aria-label="Share"
                style={{ border: 'none', background: 'transparent', fontSize: 18, cursor: 'pointer' }}
              >
                {sharing ? '…' : '📤'}
              </button>
              <button
                onClick={onClose}
                aria-label="Close"
                style={{ border: 'none', background: 'transparent', fontSize: 18, color: 'var(--color-ink)', cursor: 'pointer' }}
              >
                x
              </button>
            </div>
          </div>

          {/* Structured detail rows - icon + label + value, consistent
              with the icon-prefixed style already used elsewhere in the
              app (place/price rows), rather than literal "label: value"
              text so it reads as native KisanBit UI. */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 13 }}>
            {ownerName && (
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ width: 20, textAlign: 'center' }}>👤</span>
                <span style={{ color: 'var(--color-muted)' }}>Provider</span>
                <span style={{ marginLeft: 'auto', fontWeight: 600, color: 'var(--color-ink)' }}>{ownerName}</span>
              </div>
            )}
            {placeName && (
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ width: 20, textAlign: 'center' }}>📍</span>
                <span style={{ color: 'var(--color-muted)' }}>Place</span>
                <span style={{ marginLeft: 'auto', fontWeight: 600, color: 'var(--color-ink)' }}>{placeName}</span>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <span style={{ width: 20, textAlign: 'center' }}>{typeInfo?.emoji || '🧰'}</span>
              <span style={{ color: 'var(--color-muted)' }}>Service</span>
              <span style={{ marginLeft: 'auto', fontWeight: 600, color: 'var(--color-ink)' }}>{typeInfo?.label || serviceType}</span>
            </div>
            {equipmentModel && (
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ width: 20, textAlign: 'center' }}>🔧</span>
                <span style={{ color: 'var(--color-muted)' }}>Model</span>
                <span style={{ marginLeft: 'auto', fontWeight: 600, color: 'var(--color-ink)' }}>{equipmentModel}</span>
              </div>
            )}
            {priceAmount != null && (
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ width: 20, textAlign: 'center' }}>💰</span>
                <span style={{ color: 'var(--color-muted)' }}>Cost</span>
                <span style={{ marginLeft: 'auto', fontWeight: 700, color: 'var(--color-success)' }}>
                  ₹{priceAmount}{priceUnit ? ` / ${priceUnit}` : ''}
                </span>
              </div>
            )}
            {description && (
              <div style={{ display: 'flex', gap: 8 }}>
                <span style={{ width: 20, textAlign: 'center' }}>📝</span>
                <span style={{ color: 'var(--color-muted)' }}>Details</span>
                <span style={{ marginLeft: 'auto', fontWeight: 600, color: 'var(--color-ink)', textAlign: 'right' }}>{description}</span>
              </div>
            )}
            <div style={{ display: 'flex', gap: 8 }}>
              <span style={{ width: 20, textAlign: 'center' }}>●</span>
              <span style={{ color: 'var(--color-muted)' }}>Status</span>
              <span style={{ marginLeft: 'auto', fontWeight: 700, color: isAvailable ? 'var(--color-success)' : 'var(--color-danger)' }}>
                {isAvailable ? 'Available' : 'Unavailable'}
              </span>
            </div>
          </div>

          {ratingsLoaded && (
            <div style={{ fontSize: 13, color: 'var(--color-muted)' }}>
              {avgRating != null ? (
                <>⭐ {avgRating.toFixed(1)} <span style={{ color: 'var(--color-muted)' }}>({ratings.length} rating{ratings.length === 1 ? '' : 's'})</span></>
              ) : (
                'No ratings yet'
              )}
            </div>
          )}

          {/* Connect with Us - icon-only social buttons in a bordered
              box, shown to everyone while the service is Available.
              Verification info, not private contact, so never gated. */}
          {isAvailable && (youtubeUrl || instagramUrl || facebookUrl) && (
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
                    <span style={{
                      width: 26, height: 26, borderRadius: '50%', background: '#FF0000',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <BrandIcon brand="youtube" size={26} />
                    </span>
                    <span style={{ fontSize: 9, color: 'var(--color-muted)' }}>YouTube</span>
                  </a>
                )}
                {instagramUrl && (
                  <a href={instagramUrl} target="_blank" rel="noreferrer" style={{ textDecoration: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                    <span style={{
                      width: 26, height: 26, borderRadius: '50%', background: '#E1306C',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <BrandIcon brand="instagram" size={26} />
                    </span>
                    <span style={{ fontSize: 9, color: 'var(--color-muted)' }}>Instagram</span>
                  </a>
                )}
                {facebookUrl && (
                  <a href={facebookUrl} target="_blank" rel="noreferrer" style={{ textDecoration: 'none', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                    <span style={{
                      width: 26, height: 26, borderRadius: '50%', background: '#1877F2',
                      display: 'flex', alignItems: 'center', justifyContent: 'center',
                    }}>
                      <BrandIcon brand="facebook" size={26} />
                    </span>
                    <span style={{ fontSize: 9, color: 'var(--color-muted)' }}>Facebook</span>
                  </a>
                )}
              </div>
            </div>
          )}

          {/* Start Chat - full width, always available to non-owners.
              Call Now / WhatsApp Us below only render if the owner has
              turned on "show contact publicly" (showContactPublicly).
              If it's off, buyers only get Start Chat and must go
              through the seller's in-chat Share Phone Number flow to
              get contact details - no direct dial/WhatsApp shortcut on
              the card itself in that case. */}
          {!isOwner && ownerCheckDone && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              <button
                type="button"
                onClick={() => setChatOpen(true)}
                style={{
                  width: '100%', padding: '10px 0', borderRadius: 8, border: 'none', background: 'var(--color-navy)',
                  color: '#fff', fontWeight: 700, fontSize: 14, cursor: 'pointer',
                }}
              >
                💬 Start Chat
              </button>
              {showContactPublicly && (contactPhone || contactWhatsapp) && (
                <div style={{ display: 'flex', gap: 8 }}>
                  {contactPhone && (
                    <a
                      href={`tel:${contactPhone}`}
                      style={{
                        flex: 1, padding: '11px 0', borderRadius: 8, border: 'none',
                        background: 'var(--color-success)', color: '#fff', fontWeight: 700, fontSize: 13,
                        textAlign: 'center', textDecoration: 'none', display: 'block',
                      }}
                    >
                      📞 Call Now
                    </a>
                  )}
                  {contactWhatsapp && (
                    <a
                      href={`https://wa.me/${contactWhatsapp.replace(/\D/g, '')}`}
                      target="_blank"
                      rel="noreferrer"
                      style={{
                        flex: 1, padding: '11px 0', borderRadius: 8, border: 'none',
                        background: '#25D366', color: '#fff', fontWeight: 700, fontSize: 13,
                        textAlign: 'center', textDecoration: 'none', display: 'block',
                      }}
                    >
                      💬 WhatsApp Us
                    </a>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Star rating picker - non-owner viewers only. Tapping a star
              upserts immediately (no separate Submit step), same
              low-friction pattern as the availability toggle below. */}
          {!isOwner && ownerCheckDone && currentUserId && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--color-muted)', marginRight: 4 }}>
                {myRating ? 'Your rating:' : 'Rate this service:'}
              </span>
              {[1, 2, 3, 4, 5].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => handleRate(n)}
                  disabled={ratingBusy}
                  aria-label={`Rate ${n} star${n === 1 ? '' : 's'}`}
                  style={{
                    border: 'none', background: 'transparent', fontSize: 18, cursor: 'pointer',
                    opacity: ratingBusy ? 0.5 : 1, padding: 0,
                  }}
                >
                  {n <= myRating ? '⭐' : '☆'}
                </button>
              ))}
            </div>
          )}

        </div>
      </div>

      {chatOpen && (
        <div onClick={(e) => e.stopPropagation()}>
          <ChatModal
            listingType="service"
            listingId={id}
            sellerPhone={chatSellerPhone}
            onClose={() => setChatOpen(false)}
          />
        </div>
      )}
    </div>
  );
}