// src/context/UserContext.jsx
//
// Single source of truth for "who is the logged-in user" on the
// client. App.jsx already resolves this exactly once, via
// getCurrentSession()/onAuthStateChange() in its session-bootstrap
// effect - this context just makes that same value available to any
// descendant, instead of every descendant re-deriving it itself.
//
// BEFORE: AlertBanner, TransferRequestsBanner, CattleInfoPanel,
// FieldInfoPanel, IoTDevicesPanel, and PondsPanel each ran their own
// independent `supabase.auth.getUser()` call inside their own mount
// effect - six separate round trips, on every mount, for a value
// App.jsx already had sitting in state. Consuming this context instead
// removes all six of those calls; only App.jsx talks to auth directly.
//
// Usage: wrap the authenticated part of the tree in <UserProvider
// user={user}>, then any descendant calls `const { user } = useUser()`
// instead of awaiting supabase.auth.getUser() itself. `user` is the
// raw Supabase auth user object (or null while logged out / still
// resolving) - same shape every consumer was already destructuring
// `.id` off of.

import { createContext, useContext } from 'react';

const UserContext = createContext({ user: null });

export function UserProvider({ user, children }) {
  return (
    <UserContext.Provider value={{ user }}>
      {children}
    </UserContext.Provider>
  );
}

export function useUser() {
  return useContext(UserContext);
}