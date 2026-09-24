// src/components/IoTShopModal.jsx
//
// The REAL cart destination - opened from the header's cart icon.
// Scope per user decision: ONLY for IoT hardware (collars/tags/etc),
// NOT cattle or crops - MarketplaceModal.jsx (global cattle/crop
// browse) is a separate, unrelated screen. Checkout does NOT process
// real payment (no gateway is live yet, per ProfileScreen.jsx's
// Upgrade "Coming Soon" flow) - it creates an order/request record via
// create_iot_order(), farmer pays later (COD/manual), same
// server-side-trusted-price pattern as the RPC.

import { useEffect, useState } from 'react';
import { supabase } from '../../config/supabaseClient';

const GOLD = 'var(--color-gold)';
const NAVY = 'var(--color-navy)';

export default function IoTShopModal({ onClose, cart, setCart }) {
  const [products, setProducts] = useState([]);
  const [loadingProducts, setLoadingProducts] = useState(true);
  const [loadError, setLoadError] = useState(null);

  // Cart: { [productId]: quantity }. Now lifted up to App.jsx so the
  // Header cart-icon badge can show a live item count - this modal
  // just reads/writes the shared cart via props instead of owning its
  // own local state. Still resets on order placement (see
  // handlePlaceOrder's setCart({})), still no cross-session
  // persistence (that lives in App.jsx if ever added).

  const [view, setView] = useState('browse'); // 'browse' | 'checkout' | 'confirmed'
  const [deliveryPhone, setDeliveryPhone] = useState('');
  const [deliveryAddress, setDeliveryAddress] = useState('');
  const [placing, setPlacing] = useState(false);
  const [placeError, setPlaceError] = useState(null);
  const [confirmedOrderId, setConfirmedOrderId] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function loadProducts() {
      if (!navigator.onLine) {
        setLoadingProducts(false);
        return;
      }
      const { data, error } = await supabase
        .from('iot_products')
        .select('id, name, description, price, image_url')
        .eq('is_active', true)
        .order('name', { ascending: true });

      if (cancelled) return;
      if (error) {
        console.error('[IoTShopModal] product fetch failed:', error.message, error.details, error.hint, error.code);
        setLoadError('Products load avvaledu. Malli try cheyandi.');
      } else {
        setProducts(data || []);
      }
      setLoadingProducts(false);
    }

    loadProducts();
    return () => {
      cancelled = true;
    };
  }, []);

  const cartEntries = Object.entries(cart).filter(([, qty]) => qty > 0);
  const cartCount = cartEntries.reduce((sum, [, qty]) => sum + qty, 0);
  const cartTotal = cartEntries.reduce((sum, [productId, qty]) => {
    const product = products.find((p) => p.id === productId);
    return sum + (product ? product.price * qty : 0);
  }, 0);

  const setQuantity = (productId, qty) => {
    setCart((prev) => {
      const next = { ...prev };
      if (qty <= 0) {
        delete next[productId];
      } else {
        next[productId] = qty;
      }
      return next;
    });
  };

  const handlePlaceOrder = async () => {
    setPlaceError(null);

    if (cartEntries.length === 0) {
      setPlaceError('Your cart is empty.');
      return;
    }
    if (!deliveryPhone.trim() || !deliveryAddress.trim()) {
      setPlaceError('Please enter a delivery phone and address.');
      return;
    }

    setPlacing(true);
    const items = cartEntries.map(([productId, qty]) => ({ product_id: productId, quantity: qty }));

    const { data, error } = await supabase.rpc('create_iot_order', {
      p_items: items,
      p_delivery_phone: deliveryPhone.trim(),
      p_delivery_address: deliveryAddress.trim(),
    });

    setPlacing(false);
    if (error) {
      console.error('[IoTShopModal] order placement failed:', error.message, error.details, error.hint, error.code);
      setPlaceError('Order place avvaledu. Malli try cheyandi.');
      return;
    }

    setConfirmedOrderId(data);
    setCart({});
    setView('confirmed');
  };

  return (
    <div
      style={{
        position: 'fixed', inset: 0, zIndex: 4000, background: 'rgba(20,24,40,0.45)',
        display: 'flex', alignItems: 'flex-end',
      }}
      onClick={onClose}
    >
      <div
        className="kb-card"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%', maxHeight: '85vh', borderBottomLeftRadius: 0, borderBottomRightRadius: 0,
          display: 'flex', flexDirection: 'column',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: 16, borderBottom: '1px solid var(--color-border)' }}>
          <span className="display-text" style={{ fontSize: 17, color: NAVY }}>
            {view === 'checkout' ? 'Delivery Details' : view === 'confirmed' ? 'Order Placed' : 'IoT Shop'}
          </span>
          <button onClick={onClose} style={{ border: 'none', background: 'transparent', fontSize: 18 }}>x</button>
        </div>

        {view === 'browse' && (
          <>
            <div style={{ overflowY: 'auto', padding: 12, flex: 1 }}>
              {loadingProducts ? (
                <p style={{ color: 'var(--color-muted)', textAlign: 'center', padding: 20 }}>Loading...</p>
              ) : loadError ? (
                <p style={{ color: 'var(--color-danger)', textAlign: 'center', padding: 20 }}>{loadError}</p>
              ) : products.length === 0 ? (
                <p style={{ color: 'var(--color-muted)', textAlign: 'center', padding: 20 }}>No products available right now.</p>
              ) : (
                products.map((p) => {
                  const qty = cart[p.id] || 0;
                  return (
                    <div
                      key={p.id}
                      style={{
                        display: 'flex', gap: 12, alignItems: 'center', padding: '12px 8px',
                        borderBottom: '1px solid var(--color-border)',
                      }}
                    >
                      <div
                        style={{
                          width: 52, height: 52, borderRadius: 10, flexShrink: 0, overflow: 'hidden',
                          background: 'var(--color-bg)', display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 22, border: '1px solid var(--color-border)',
                        }}
                      >
                        {p.image_url ? (
                          <img src={p.image_url} alt={p.name} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
                        ) : (
                          '📡'
                        )}
                      </div>

                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontWeight: 600, fontSize: 14 }}>{p.name}</div>
                        {p.description && (
                          <div style={{ fontSize: 12, color: 'var(--color-muted)' }}>{p.description}</div>
                        )}
                        <div style={{ fontSize: 13, fontWeight: 700, color: 'var(--color-success)', marginTop: 2 }}>
                          Rs{p.price}
                        </div>
                      </div>

                      {qty === 0 ? (
                        <button
                          onClick={() => setQuantity(p.id, 1)}
                          style={{
                            flexShrink: 0, padding: '8px 14px', borderRadius: 8, border: 'none',
                            background: GOLD, color: NAVY, fontWeight: 700, fontSize: 13,
                          }}
                        >
                          Add
                        </button>
                      ) : (
                        <div style={{ flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8 }}>
                          <button
                            onClick={() => setQuantity(p.id, qty - 1)}
                            style={qtyBtnStyle}
                            aria-label="Decrease quantity"
                          >
                            −
                          </button>
                          <span style={{ minWidth: 18, textAlign: 'center', fontWeight: 700 }}>{qty}</span>
                          <button
                            onClick={() => setQuantity(p.id, qty + 1)}
                            style={qtyBtnStyle}
                            aria-label="Increase quantity"
                          >
                            +
                          </button>
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {cartCount > 0 && (
              <div style={{ padding: 14, borderTop: '1px solid var(--color-border)', display: 'flex', gap: 12, alignItems: 'center' }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 12, color: 'var(--color-muted)' }}>{cartCount} item{cartCount === 1 ? '' : 's'}</div>
                  <div style={{ fontWeight: 700, fontSize: 15, color: NAVY }}>Rs{cartTotal}</div>
                </div>
                <button
                  onClick={() => setView('checkout')}
                  style={{
                    padding: '12px 22px', borderRadius: 10, border: 'none',
                    background: GOLD, color: NAVY, fontWeight: 700, fontSize: 14,
                  }}
                >
                  Checkout
                </button>
              </div>
            )}
          </>
        )}

        {view === 'checkout' && (
          <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12, overflowY: 'auto' }}>
            <div style={{ fontSize: 13, color: 'var(--color-muted)' }}>
              {cartCount} item{cartCount === 1 ? '' : 's'} - Rs{cartTotal} total. Payment isn't online yet - the farmer
              will contact you to arrange payment on delivery.
            </div>

            <div>
              <label style={labelStyle}>Delivery Phone</label>
              <input
                type="tel"
                value={deliveryPhone}
                onChange={(e) => setDeliveryPhone(e.target.value)}
                placeholder="10-digit mobile number"
                style={inputStyle}
              />
            </div>

            <div>
              <label style={labelStyle}>Delivery Address</label>
              <textarea
                value={deliveryAddress}
                onChange={(e) => setDeliveryAddress(e.target.value)}
                placeholder="Village, mandal, district, pincode"
                rows={3}
                style={{ ...inputStyle, resize: 'vertical', fontFamily: 'inherit' }}
              />
            </div>

            {placeError && <div style={{ color: 'var(--color-danger)', fontSize: 13 }}>{placeError}</div>}

            <div style={{ display: 'flex', gap: 10 }}>
              <button
                onClick={() => setView('browse')}
                disabled={placing}
                style={{ flex: 1, minHeight: 48, padding: 10, borderRadius: 10, border: '1px solid var(--color-border)', background: 'var(--color-card)', color: 'var(--color-ink)' }}
              >
                Back
              </button>
              <button
                onClick={handlePlaceOrder}
                disabled={placing}
                style={{ flex: 1, minHeight: 48, padding: 10, borderRadius: 10, border: 'none', background: GOLD, color: NAVY, fontWeight: 700, opacity: placing ? 0.6 : 1 }}
              >
                {placing ? 'Placing...' : 'Place Order'}
              </button>
            </div>
          </div>
        )}

        {view === 'confirmed' && (
          <div style={{ padding: 24, textAlign: 'center', display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
            <div style={{ fontSize: 36 }}>✅</div>
            <div style={{ fontWeight: 700, fontSize: 16, color: NAVY }}>Order placed!</div>
            <div style={{ fontSize: 13, color: 'var(--color-muted)' }}>
              Order ID: <span style={{ fontFamily: 'monospace' }}>{confirmedOrderId}</span>
            </div>
            <div style={{ fontSize: 13, color: 'var(--color-muted)' }}>
              We'll reach out on the phone number you gave to confirm payment and delivery.
            </div>
            <button
              onClick={onClose}
              style={{ marginTop: 8, minHeight: 48, padding: '10px 24px', borderRadius: 10, border: 'none', background: GOLD, color: NAVY, fontWeight: 700 }}
            >
              Done
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const qtyBtnStyle = {
  width: 28, height: 28, borderRadius: '50%', border: '1px solid var(--color-border)',
  background: 'var(--color-card)', color: 'var(--color-ink)', fontSize: 16, fontWeight: 700,
  display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, lineHeight: 1,
};

const labelStyle = {
  display: 'block', fontSize: 12, fontWeight: 600, color: 'var(--color-muted)', marginBottom: 4,
};

const inputStyle = {
  width: '100%', padding: 10, borderRadius: 8, border: '1px solid var(--color-border)',
  fontSize: 14, fontFamily: 'inherit', outline: 'none',
};