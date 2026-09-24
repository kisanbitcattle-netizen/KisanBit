// src/components/Header.jsx
//
// App header — real brand logo + wordmark (no emoji), a proper
// segmented Farmer/Buyer toggle (for testing both views), and a
// marketplace "cart" icon so buyers always have a visible way to
// browse listed cattle & crops.

export default function Header({ isFarmerView, onToggleView, cartCount, onOpenMarketplace }) {
  return (
    <header className="kb-app-header">
      <div className="kb-brand">
        <img src="/assets/branding/kisanbit-logo.png" alt="KisanBit" />
        <span className="wordmark">KisanBit</span>
      </div>

      <div className="kb-header-actions">
        <div className="kb-role-toggle">
          <button
            className={isFarmerView ? 'active' : ''}
            onClick={() => onToggleView(true)}
          >
            Farmer
          </button>
          <button
            className={!isFarmerView ? 'active' : ''}
            onClick={() => onToggleView(false)}
          >
            Buyer
          </button>
        </div>

        <button className="kb-icon-btn" onClick={onOpenMarketplace} aria-label="Marketplace">
          🛒
          {cartCount > 0 && <span className="badge">{cartCount}</span>}
        </button>
      </div>
    </header>
  );
}