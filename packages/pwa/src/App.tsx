import { NavLink, Navigate, Route, Routes } from "react-router-dom";
import { Connect } from "./pages/Connect.js";
import { Passkeys } from "./pages/Passkeys.js";
import { Smokes } from "./pages/Smokes.js";
import { useConnectionStore } from "./store.js";

export function App() {
  const connection = useConnectionStore((s) => s.connection);
  return (
    <div className="app">
      <header className="app-header">
        <h1>PNM Wallet</h1>
        <nav>
          <NavLink to="/" end>
            Connection
          </NavLink>
          <NavLink to="/passkeys" aria-disabled={!connection}>
            Passkeys
          </NavLink>
          <NavLink to="/smokes">Diagnostics</NavLink>
        </nav>
      </header>
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Connect />} />
          <Route
            path="/passkeys"
            element={connection ? <Passkeys /> : <Navigate to="/" replace />}
          />
          <Route path="/smokes" element={<Smokes />} />
        </Routes>
      </main>
    </div>
  );
}
