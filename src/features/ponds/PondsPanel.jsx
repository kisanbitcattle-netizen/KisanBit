// src/components/PondsPanel.jsx
//
// Fish-stock manager for HomeScreen. Ponds themselves (name, size,
// water source) are now Profile-tab-only, created/edited/deleted via
// ProfileScreen.jsx + AddPondForm.jsx (same split as Field/Crop:
// Field editing is Profile-only, crops are added on HomeScreen). This
// panel fetches Ponds read-only (to populate/label the fish-stock
// list) and owns full CRUD on pond_fish_stock only.
//
// Same shape as FieldInfoPanel.jsx: a thin collapsible-card shell that
// owns list state + offline cache + realtime sync, delegating the
// actual add/edit UI to a standalone form component
// (AddFishStockForm.jsx, same role AddCropForm.jsx plays for
// FieldInfoPanel). Previously had its own inline FishForm duplicating
// AddFishStockForm.jsx's logic with a different field set (missing
// water_type/ph/temperature_c/dissolved_oxygen_mg_l entirely, which
// PondDetailModal.jsx's water-quality chips depend on) - that's been
// removed so there's one form, one field list, used from both
// PondDetailModal-adjacent flows and here.
//
// ASSUMPTIONS (flag for confirmation):
// 1. Always renders the logged-in farmer's own ponds/fish stock,
//    regardless of the Farmer/Buyer toggle - that toggle only changes
//    what MapPreviewCard/FullMapModal show. is_listed_for_sale exists
//    on pond_fish_stock as a forward-compatible column for a separately
//    queued "Fish-specific pond listings" (buyer-facing) feature, but
//    no public/buyer view is wired up in this panel.
// 2. Reuses the existing AddFishStockForm.jsx as-is (extended with an
//    `editingFish` prop, mirroring AddCropForm.jsx's `editingCrop`, so
//    this panel's per-row "Edit" button has somewhere to go) - neither
//    PondCard below nor the rest of this file otherwise modifies it.
// 3. If a farmer has zero Ponds registered (in Profile), this panel
//    shows a message pointing them to Profile rather than letting them
//    create a Pond from here - Pond creation only happens in Profile
//    now.

import { useEffect, useState } from 'react';
import { supabase } from '../../config/supabaseClient';
import { offlineCache } from '../../utils/offlineCache';
import AddFishStockForm from './AddFishStockForm';
import SectionBoxHeader from '../../components/SectionBoxHeader';
import CardHeaderStrip from '../../components/CardHeaderStrip';
import { useUser } from '../../context/UserContext';

// Green fish-card header, matching CropCard's green (per explicit
// request) - note this now differs from HomeScreen.jsx's blue
// (#1976d2) top-border accent on the outer Ponds grid box, which is
// untouched. Only the fish-item card headers inside this panel use
// green now.
const POND_ACCENT = 'var(--color-success, #2e8b57)';

function PondCard({ pond, fishStock, onAddFish, onEditFish, onDeleteFish }) {
  return (
    <div className="kb-card" style={{ padding: 12 }}>
      <div style={{ marginBottom: 8 }}>
        <p style={{ fontSize: 14, fontWeight: 700, color: 'var(--color-ink)', marginBottom: 2 }}>{pond.pond_name}</p>
        <p style={{ fontSize: 12, color: 'var(--color-muted)' }}>
          {pond.size_acres != null ? `${pond.size_acres} acres` : ''}
          {pond.size_acres != null && pond.water_source ? ' · ' : ''}
          {pond.water_source || ''}
        </p>
      </div>

      {fishStock.map((f) => (
        <div key={f.id} style={{ marginTop: 8, borderRadius: 10, overflow: 'hidden', border: '1px solid var(--color-border)' }}>
          <CardHeaderStrip
            color={POND_ACCENT}
            avatarFallback="🐟"
            onEdit={() => onEditFish(pond, f)}
            del={{ mode: 'confirm', itemLabel: 'fish stock entry', onConfirm: () => onDeleteFish(f) }}
          />
          <div style={{ padding: '8px 10px', background: 'var(--color-bg)' }}>
            <div style={{ fontSize: 13, color: 'var(--color-ink)', fontWeight: 700 }}>{f.fish_species}</div>
            <div style={{ fontSize: 12, color: 'var(--color-muted)', marginTop: 2 }}>
              {f.quantity != null ? `${f.quantity} fish` : ''}
              {f.is_listed_for_sale ? ' · 💰 Listed' : ''}
            </div>
          </div>
        </div>
      ))}

      <button
        onClick={() => onAddFish(pond)}
        style={{ marginTop: 8, width: '100%', padding: '9px 10px', borderRadius: 10, border: '1px solid var(--color-gold)', background: 'transparent', color: 'var(--color-gold)', fontSize: 13, fontWeight: 700 }}
      >
        + Add Fish
      </button>
    </div>
  );
}

export default function PondsPanel({ isOpen, onToggle }) {
  const [ponds, setPonds] = useState([]);
  const [fishStock, setFishStock] = useState([]);
  const [fishFormPond, setFishFormPond] = useState(null);
  const [editingFish, setEditingFish] = useState(null);
  // True when opened via the header's top-level "+ Add Stock" button
  // (no pond pre-selected - AddFishStockForm shows the pond-picker dropdown),
  // as opposed to fishFormPond being set (opened via a specific pond
  // card's "+ Add Fish", locked to that pond). Mirrors FieldInfoPanel's
  // isAddOpen (top-level, unlocked) vs addCropField (per-card, locked)
  // split.
  const [isTopFormOpen, setIsTopFormOpen] = useState(false);
  const [actionError, setActionError] = useState(null);
  // Read from context instead of calling supabase.auth.getUser() here -
  // App.jsx already resolved this once. See UserContext.jsx.
  const { user } = useUser();

  useEffect(() => {
    let channel;
    let cancelled = false;

    async function loadAll(userId) {
      const cachedPonds = await offlineCache.getAll('pondsPanel');
      const cachedFish = await offlineCache.getAll('pondFishStockPanel');
      if (cancelled) return;
      if (cachedPonds.length) setPonds(cachedPonds);
      if (cachedFish.length) setFishStock(cachedFish);

      if (!navigator.onLine) return;

      // Ponds are fetched read-only here (create/edit/delete moved to
      // ProfileScreen.jsx + AddPondForm.jsx) - only used to label/group
      // the fish-stock list below.
      let pondsQuery = supabase.from('ponds').select('*').order('created_at', { ascending: false });
      let fishQuery = supabase.from('pond_fish_stock').select('*');
      if (userId) {
        pondsQuery = pondsQuery.eq('owner_id', userId);
        fishQuery = fishQuery.eq('owner_id', userId);
      }

      const [{ data: pondRows, error: pondError }, { data: fishRows, error: fishError }] = await Promise.all([pondsQuery, fishQuery]);
      if (cancelled) return;

      if (pondError) {
        console.error('[PondsPanel] ponds fetch failed:', pondError.message, pondError.details, pondError.hint, pondError.code);
        return;
      }
      if (fishError) {
        console.error('[PondsPanel] fish stock fetch failed:', fishError.message, fishError.details, fishError.hint, fishError.code);
      }

      const finalPonds = pondRows || [];
      const finalFish = fishRows || [];
      offlineCache.putAll('pondsPanel', finalPonds);
      offlineCache.putAll('pondFishStockPanel', finalFish);
      setPonds(finalPonds);
      setFishStock(finalFish);
    }

    // Reads `user` straight from context instead of awaiting
    // supabase.auth.getUser() here - App.jsx already resolved it once.
    loadAll(user?.id);

    if (user) {
      channel = supabase
        .channel(`ponds-panel-${user.id}-${Math.random().toString(36).slice(2)}`)
        .on('postgres_changes', { event: '*', schema: 'public', table: 'ponds', filter: `owner_id=eq.${user.id}` }, () => loadAll(user.id))
        .on('postgres_changes', { event: '*', schema: 'public', table: 'pond_fish_stock', filter: `owner_id=eq.${user.id}` }, () => loadAll(user.id))
        .subscribe();
    }

    return () => {
      cancelled = true;
      if (channel) supabase.removeChannel(channel);
    };
  }, [user?.id]);

  const handleFishSaved = (savedFish) => {
    const isEditing = fishStock.some((f) => f.id === savedFish.id);
    const updated = isEditing ? fishStock.map((f) => (f.id === savedFish.id ? savedFish : f)) : [...fishStock, savedFish];
    setFishStock(updated);
    offlineCache.putAll('pondFishStockPanel', updated);
    setFishFormPond(null);
    setEditingFish(null);
    setIsTopFormOpen(false);
  };

  const handleDeleteFish = async (fish) => {
    setActionError(null);
    const { error } = await supabase.from('pond_fish_stock').delete().eq('id', fish.id);
    if (error) {
      setActionError('Could not delete this fish stock entry. Try again.');
      return;
    }
    const updated = fishStock.filter((f) => f.id !== fish.id);
    setFishStock(updated);
    offlineCache.putAll('pondFishStockPanel', updated);
  };

  return (
    <div className="kb-card" style={{ overflow: 'hidden', flexShrink: 0 }}>
      <SectionBoxHeader
        icon="🐟"
        title="Ponds"
        count={ponds.length}
        isOpen={isOpen}
        onToggle={onToggle}
        onAdd={isTopFormOpen ? undefined : () => setIsTopFormOpen(true)}
        addLabel="+ Add Stock"
      />

      {actionError && (
        <div style={{ margin: '0 12px 12px', padding: '8px 12px', borderRadius: 8, border: '1px solid var(--color-danger)', background: 'var(--color-card)', color: 'var(--color-danger)', fontSize: 13, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <span>{actionError}</span>
          <button onClick={() => setActionError(null)} style={{ background: 'none', border: 'none', color: 'var(--color-danger)', fontWeight: 700, fontSize: 15, cursor: 'pointer', lineHeight: 1 }} aria-label="Dismiss">×</button>
        </div>
      )}

      {isOpen && (
        <div style={{ borderTop: '1px solid var(--color-border)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {ponds.length === 0 && (
            <p style={{ padding: 6, color: 'var(--color-muted)' }}>
              No Ponds registered yet. Add one from your Profile tab first.
            </p>
          )}
          {ponds.map((p) => (
            <PondCard
              key={p.id}
              pond={p}
              fishStock={fishStock.filter((f) => f.pond_id === p.id)}
              onAddFish={(pond) => { setEditingFish(null); setFishFormPond(pond); }}
              onEditFish={(pond, fish) => { setEditingFish(fish); setFishFormPond(pond); }}
              onDeleteFish={handleDeleteFish}
            />
          ))}
        </div>
      )}

      {fishFormPond && (
        <AddFishStockForm
          key={`${fishFormPond.id}-${editingFish?.id || 'new'}`}
          pondId={fishFormPond.id}
          editingFish={editingFish}
          onSaved={handleFishSaved}
          onClose={() => { setFishFormPond(null); setEditingFish(null); }}
        />
      )}

      {isTopFormOpen && (
        <AddFishStockForm
          pondId={null}
          editingFish={null}
          onSaved={handleFishSaved}
          onClose={() => setIsTopFormOpen(false)}
        />
      )}
    </div>
  );
}