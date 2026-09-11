import React, { useState, useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Routes,
  Route,
  NavLink,
  Link,
  useLocation,
  Navigate,
} from "react-router-dom";
import {
  LayoutDashboard,
  ShoppingBag,
  Users,
  Settings as SettingsIcon,
  Layers,
  ArrowUpRight,
  PanelLeftClose,
  PanelLeftOpen,
  LogOut,
  Plus,
  ChevronsUpDown,
  Command,
  Radio,
  Handshake,
  BadgeDollarSign,
  X,
} from "lucide-react";
import { api, useApi, ConfigContext } from "./api";
import { ErrorBox, Loading, Field } from "./components";
import { Reports } from "./pages/Reports";
import { Orders, OrderDetails, OrderForm } from "./pages/Orders";
import { Expenses } from "./pages/Expenses";
import { Sales } from "./pages/Sales";
import { Settings } from "./pages/Settings";
import { DeliverySyncLogs } from "./pages/DeliverySyncLogs";
import { Customers } from "./pages/Customers";
import { UserContext, Can, Guard, P, can, hasBusinessAccess } from "./access";
import {
  UserManagement,
  SessionList,
  RegistrationSettings,
  AuditView,
  TeamAnalytics,
} from "./pages/Administration";
import { Agencies } from "./pages/Agencies";
import "./styles.css";
function Login({ reload }) {
  const [register, setRegister] = useState(false),
    [name, setName] = useState("");
  const [email, setEmail] = useState(""),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    try {
      const key = e.currentTarget.elements.registrationKey?.value;
      if (e.currentTarget.elements.registrationKey)
        e.currentTarget.elements.registrationKey.value = "";
      await api(register ? "/auth/register" : "/auth/login", {
        method: "POST",
        body: {
          email,
          password,
          ...(register ? { name, registrationKey: key } : {}),
        },
      });
      reload();
    } catch (e) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="login">
      <form className="panel" onSubmit={submit} aria-busy={busy}>
        <div className="brand-symbol">
          <Command />
        </div>
        <div className="eyebrow">TAMQO × LOGIX</div>
        <h1>{register ? "Join your workspace." : "Welcome back."}</h1>
        <p>
          {register
            ? "Create your account with an authorized registration key."
            : "Sign in to your business workspace."}
        </p>
        <ErrorBox error={error} />
        {register && (
          <>
            <Field label="Name">
              <input
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
            </Field>
            <Field label="Registration Auth Key">
              <input
                required
                type="password"
                name="registrationKey"
                autoComplete="off"
              />
            </Field>
          </>
        )}
        <Field label="Email">
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>
        <Field label="Password">
          <input
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>
        <button className="primary" disabled={busy}>
          {busy ? "Please wait…" : register ? "Register" : "Sign in"}
          <ArrowUpRight size={16} />
        </button>
        <button type="button" onClick={() => setRegister(!register)}>
          {register ? "Back to sign in" : "Register with an Auth Key"}
        </button>
      </form>
    </div>
  );
}
function Workspace({ user, logout }) {
  const configuration = useApi("/config"),
    [collapsed, setCollapsed] = useState(() => window.innerWidth <= 760),
    location = useLocation();
  const [mobile, setMobile] = useState(() => window.innerWidth <= 760);
  const sidebarRef = useRef(null);
  const toggleRef = useRef(null);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 760px)");
    const sync = () => {
      setMobile(media.matches);
      if (media.matches) setCollapsed(true);
    };
    media.addEventListener("change", sync);
    return () => media.removeEventListener("change", sync);
  }, []);
  useEffect(() => {
    if (!mobile || collapsed) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const sidebar = sidebarRef.current;
    sidebar.querySelector("button, a")?.focus();
    const handleKey = (event) => {
      if (event.key === "Escape") setCollapsed(true);
      if (event.key !== "Tab") return;
      const focusable = [
        ...sidebar.querySelectorAll("a[href], button:not([disabled])"),
      ];
      const first = focusable[0],
        last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    document.addEventListener("keydown", handleKey);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener("keydown", handleKey);
      toggleRef.current?.focus();
    };
  }, [mobile, collapsed]);
  const section = location.pathname.split("/")[1] || "Overview";
  const links = [
    [
      "/",
      "Overview",
      LayoutDashboard,
      [P.analytics.viewOwn, P.analytics.viewBusiness, P.analytics.viewGlobal],
    ],
    ["/orders", "Orders", ShoppingBag, [P.orders.viewOwn, P.orders.viewAll]],
    ["/sales", "Sales", BadgeDollarSign, [P.sales.viewOwn, P.sales.viewAll]],
    ["/customers", "Customers", Users, [P.customers.view]],
    [
      "/team",
      "Team analytics",
      Users,
      [P.analytics.viewOwn, P.analytics.viewBusiness, P.analytics.viewGlobal],
    ],
  ];
  return (
    <UserContext.Provider value={user}>
      <ConfigContext.Provider value={configuration}>
        <div className={`app-shell ${collapsed ? "collapsed" : ""}`}>
          <a className="skip-link" href="#workspace-content">
            Skip to content
          </a>
          {mobile && !collapsed && (
            <button
              className="nav-backdrop"
              aria-label="Dismiss navigation"
              tabIndex={-1}
              onClick={() => setCollapsed(true)}
            />
          )}
          <aside
            className="sidebar"
            id="workspace-navigation"
            ref={sidebarRef}
            aria-label="Workspace navigation"
            role={mobile && !collapsed ? "dialog" : undefined}
            aria-modal={mobile && !collapsed ? true : undefined}
            inert={collapsed}
            onClick={(event) => {
              if (mobile && event.target.closest("a")) setCollapsed(true);
            }}
          >
            <button
              className="icon-button nav-close"
              aria-label="Close navigation"
              onClick={() => setCollapsed(true)}
            >
              <X size={18} />
            </button>
            <Link to="/" className="brand">
              <div className="brand-symbol">
                <Command size={22} />
              </div>
              <div>
                <strong>
                  tamqo<span> × </span>logix
                </strong>
                <small>Business workspace</small>
              </div>
            </Link>
            <div className="workspace-switch">
              <div className="workspace-avatar">TL</div>
              <div>
                <b>Partnership workspace</b>
                <small>Algeria · DZD</small>
              </div>
              <ChevronsUpDown size={14} />
            </div>
            <div className="nav-label">Workspace</div>
            <nav>
              {links
                .filter((l) => l[3].some((p) => can(user, p)))
                .map(([to, label, Icon]) => (
                  <NavLink
                    key={to}
                    to={to}
                    end={to === "/"}
                    onClick={() =>
                      window.innerWidth < 760 && setCollapsed(true)
                    }
                  >
                    <Icon size={18} />
                    <span>{label}</span>
                  </NavLink>
                ))}
            </nav>
            <div className="nav-label">Businesses</div>
            <nav>
              {hasBusinessAccess(user, "TAMQO") && (
                <>
                  <Can
                    permission={[
                      P.analytics.viewOwn,
                      P.analytics.viewBusiness,
                      P.analytics.viewGlobal,
                    ]}
                  >
                    <NavLink to="/tamqo" end>
                      <span className="business-icon tamqo">t</span>
                      <span>Tamqo</span>
                      <span className="nav-note">AI</span>
                    </NavLink>
                  </Can>
                  <Can permission={P.expenses.view}>
                    <NavLink to="/tamqo/expenses">
                      <span className="business-icon tamqo">t</span>
                      <span>Tamqo expenses</span>
                    </NavLink>
                  </Can>
                </>
              )}
              {hasBusinessAccess(user, "LOGIX") && (
                <>
                  <Can
                    permission={[
                      P.analytics.viewOwn,
                      P.analytics.viewBusiness,
                      P.analytics.viewGlobal,
                    ]}
                  >
                    <NavLink to="/logix" end>
                      <span className="business-icon logix">l</span>
                      <span>Logix</span>
                      <span className="nav-note">NFC</span>
                    </NavLink>
                  </Can>
                  <Can permission={P.expenses.view}>
                    <NavLink to="/logix/expenses">
                      <span className="business-icon logix">l</span>
                      <span>Logix expenses</span>
                    </NavLink>
                  </Can>
                </>
              )}
              {hasBusinessAccess(user, "PARTNERSHIP") && (
                <Can permission={P.partnership.view}>
                  <NavLink to="/partnership">
                    <Handshake size={18} />
                    <span>Partnership</span>
                  </NavLink>
                </Can>
              )}
            </nav>
            <div className="sidebar-bottom">
              <div className="connected">
                <span className="status-dot" />
                One workspace. Both businesses.
                <p>Clear numbers. Better decisions.</p>
              </div>
              <nav>
                <Can permission={P.settings.view}>
                  <NavLink to="/settings" end>
                    <SettingsIcon size={18} />
                    <span>Settings</span>
                  </NavLink>
                </Can>
                <Can permission={P.users.view}>
                  <NavLink to="/settings/users">Users</NavLink>
                </Can>
                <Can permission={P.deliveryAgencies.view}>
                  <NavLink to="/settings/agencies">Delivery agencies</NavLink>
                </Can>
                <Can permission={P.deliverySync.view}>
                  <NavLink to="/settings/delivery-sync">
                    Delivery Sync Logs
                  </NavLink>
                </Can>
                <Can permission={P.sessions.viewOwn}>
                  <NavLink to="/settings/sessions">My sessions</NavLink>
                </Can>
                <Can permission={P.audit.view}>
                  <NavLink to="/settings/audit">Audit log</NavLink>
                </Can>
                {user.role === "SUPER_ADMIN" && (
                  <NavLink to="/settings/registration">Registration</NavLink>
                )}
              </nav>
              <div className="profile">
                <div className="avatar">A</div>
                <div>
                  <b>{user.name}</b>
                  <small>
                    {user.development ? "Local development" : user.email}
                  </small>
                </div>
                {!user.development && (
                  <button onClick={logout} title="Sign out">
                    <LogOut size={15} />
                  </button>
                )}
              </div>
            </div>
          </aside>
          <div className="main-shell" inert={mobile && !collapsed}>
            <header className="topbar">
              <div>
                <button
                  className="icon-button"
                  onClick={() => setCollapsed(!collapsed)}
                  aria-label="Toggle navigation"
                  ref={toggleRef}
                  aria-expanded={!collapsed}
                  aria-controls="workspace-navigation"
                >
                  {collapsed ? (
                    <PanelLeftOpen size={18} />
                  ) : (
                    <PanelLeftClose size={18} />
                  )}
                </button>
                <span className="breadcrumb">
                  Workspace <span>/</span>{" "}
                  <b>{section[0].toUpperCase() + section.slice(1)}</b>
                </span>
              </div>
              <div>
                <span className="live-label">
                  <Radio size={13} />
                  Connected workspace
                </span>
                <Can permission={P.orders.create}>
                  <Link className="primary small" to="/orders/new">
                    <Plus size={15} />
                    Create order
                  </Link>
                </Can>
              </div>
            </header>
            <main id="workspace-content" tabIndex={-1}>
              <ErrorBox error={configuration.error} />
              {configuration.loading && !configuration.data ? (
                <Loading />
              ) : (
                <Routes>
                  <Route
                    path="/"
                    element={
                      <Guard
                        permissions={[
                          P.analytics.viewOwn,
                          P.analytics.viewBusiness,
                          P.analytics.viewGlobal,
                        ]}
                      >
                        <Reports scope="all" />
                      </Guard>
                    }
                  />
                  <Route
                    path="/team"
                    element={
                      <Guard
                        permissions={[
                          P.analytics.viewOwn,
                          P.analytics.viewBusiness,
                          P.analytics.viewGlobal,
                        ]}
                      >
                        <TeamAnalytics />
                      </Guard>
                    }
                  />
                  <Route
                    path="/settings/users"
                    element={
                      <Guard permissions={[P.users.view]}>
                        <UserManagement />
                      </Guard>
                    }
                  />
                  <Route
                    path="/settings/agencies"
                    element={
                      <Guard permissions={[P.deliveryAgencies.view]}>
                        <Agencies />
                      </Guard>
                    }
                  />
                  <Route
                    path="/settings/delivery-sync"
                    element={
                      <Guard permissions={[P.deliverySync.view]}>
                        <DeliverySyncLogs />
                      </Guard>
                    }
                  />
                  <Route
                    path="/settings/sessions"
                    element={
                      <Guard permissions={[P.sessions.viewOwn]}>
                        <SessionList />
                      </Guard>
                    }
                  />
                  <Route
                    path="/settings/audit"
                    element={
                      <Guard permissions={[P.audit.view]}>
                        <AuditView />
                      </Guard>
                    }
                  />
                  <Route
                    path="/settings/registration"
                    element={
                      user.role === "SUPER_ADMIN" ? (
                        <RegistrationSettings />
                      ) : (
                        <Navigate to="/" />
                      )
                    }
                  />
                  <Route
                    path="/orders"
                    element={
                      <Guard permissions={[P.orders.viewOwn, P.orders.viewAll]}>
                        <Orders />
                      </Guard>
                    }
                  />
                  <Route
                    path="/orders/new"
                    element={
                      <Guard permissions={[P.orders.create]}>
                        <OrderForm />
                      </Guard>
                    }
                  />
                  <Route
                    path="/orders/:id"
                    element={
                      <Guard permissions={[P.orders.viewOwn, P.orders.viewAll]}>
                        <OrderDetails />
                      </Guard>
                    }
                  />
                  <Route
                    path="/orders/:id/edit"
                    element={
                      <Guard
                        permissions={[P.orders.updateOwn, P.orders.updateAll]}
                      >
                        <OrderForm />
                      </Guard>
                    }
                  />
                  <Route
                    path="/sales"
                    element={
                      <Guard permissions={[P.sales.viewOwn, P.sales.viewAll]}>
                        <Sales />
                      </Guard>
                    }
                  />
                  <Route
                    path="/tamqo"
                    element={
                      <Guard
                        permissions={[
                          P.analytics.viewOwn,
                          P.analytics.viewBusiness,
                          P.analytics.viewGlobal,
                        ]}
                        business="TAMQO"
                      >
                        <Reports scope="tamqo" />
                      </Guard>
                    }
                  />
                  <Route
                    path="/logix"
                    element={
                      <Guard
                        permissions={[
                          P.analytics.viewOwn,
                          P.analytics.viewBusiness,
                          P.analytics.viewGlobal,
                        ]}
                        business="LOGIX"
                      >
                        <Reports scope="logix" />
                      </Guard>
                    }
                  />
                  <Route
                    path="/partnership"
                    element={
                      <Guard
                        permissions={[P.partnership.view]}
                        business="PARTNERSHIP"
                      >
                        <Reports scope="partnership" />
                      </Guard>
                    }
                  />
                  <Route
                    path="/:business/expenses"
                    element={
                      <Guard permissions={[P.expenses.view]}>
                        <Expenses />
                      </Guard>
                    }
                  />
                  <Route
                    path="/customers"
                    element={
                      <Guard permissions={[P.customers.view]}>
                        <Customers />
                      </Guard>
                    }
                  />
                  <Route
                    path="/settings"
                    element={
                      <Guard permissions={[P.settings.view]}>
                        <Settings />
                      </Guard>
                    }
                  />
                  <Route path="*" element={<Navigate to="/" replace />} />
                </Routes>
              )}
              <footer className="page-footer">
                <span>tamqo × logix</span>
                <span>All amounts in Algerian dinar (DA) · Africa/Algiers</span>
                <Layers size={14} />
              </footer>
            </main>
          </div>
        </div>
      </ConfigContext.Provider>
    </UserContext.Provider>
  );
}
class ErrorBoundary extends React.Component {
  state = { error: false };
  static getDerivedStateFromError() {
    return { error: true };
  }
  render() {
    return this.state.error ? (
      <div className="fatal">
        <h1>This view could not be loaded.</h1>
        <p>Your saved records are safe. Reload the workspace to try again.</p>
        <button className="primary" onClick={() => window.location.reload()}>
          Reload workspace
        </button>
      </div>
    ) : (
      this.props.children
    );
  }
}
function App() {
  const session = useApi("/auth/session");
  const userId = session.data?.user?._id;
  useEffect(() => {
    if (!userId) return;
    const refresh = () => {
      if (!document.hidden) session.reload();
    };
    const interval = window.setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [userId, session.reload]);
  if (session.loading && !session.data) return <Loading />;
  if (session.error)
    return (
      <div className="fatal">
        <h1>Workspace unavailable</h1>
        <ErrorBox error={session.error} />
        <p>Check that the API and MongoDB are running.</p>
        <button onClick={session.reload}>Retry connection</button>
      </div>
    );
  return session.data.user ? (
    <Workspace
      user={session.data.user}
      logout={async () => {
        await api("/auth/logout", { method: "POST" });
        session.reload();
      }}
    />
  ) : (
    <Login reload={session.reload} />
  );
}
createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <BrowserRouter>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </BrowserRouter>
  </React.StrictMode>,
);
