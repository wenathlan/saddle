import { createRoot } from "react-dom/client";
import { TooltipProvider } from "@/tooltip";
import { Toaster } from "@/sonner";
import "./index.css";
import NotFound from "./NotFound/NotFound";
import { Route, Router as WouterRouter, Switch } from "wouter";
import ErrorBoundary from "./ErrorBoundary";
import { ThemeProvider } from "./ThemeContext";
import Home from "./Home/Home";
import Architecture from "./Architecture/Architecture";
import AgentBrowser from "./AgentBrowser/AgentBrowser";
import Compute from "./Compute/Compute";
import Integrations from "./Integrations/Integrations";
import Docs from "./Docs/Docs";
import Playground from "./Playground/Playground";
import Console from "./Console/Console";
import Dashboard from "./Dashboard/Dashboard";
import Login from "./Login/Login";
import Register from "./Register/Register";


function Router() {
  return (
    <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
      <Switch>
        <Route path={"/"} component={Home} />
        <Route path={"/architecture"} component={Architecture} />
        <Route path={"/agent-browser"} component={AgentBrowser} />
        <Route path={"/compute"} component={Compute} />
        <Route path={"/integrations"} component={Integrations} />
        <Route path={"/playground"} component={Playground} />
        <Route path={"/console"} component={Console} />
        <Route path={"/login"} component={Login} />
        <Route path={"/register"} component={Register} />
        {/* Session-gated panel: the Dashboard component decides on its own
            whether a session exists and renders the fatal sign-in panel when
            it does not, like the absorbed static dashboard. */}
        <Route path={"/dashboard"} component={Dashboard} />
        <Route path={"/docs"} component={Docs} />
        <Route path={"/404"} component={NotFound} />
        {/* Final fallback route */}
        <Route component={NotFound} />
      </Switch>
    </WouterRouter>
  );
}

// NOTE: About Theme
// - First choose a default theme according to your design style (dark or light bg), than change color palette in index.css
//   to keep consistent foreground/background color across components
// - If you want to make theme switchable, pass `switchable` ThemeProvider and use `useTheme` hook

function App() {
  return (
    <ErrorBoundary>
      <ThemeProvider defaultTheme="light">
        <TooltipProvider>
          <Toaster />
          <Router />
        </TooltipProvider>
      </ThemeProvider>
    </ErrorBoundary>
  );
}

/* The self-mount: the app owns its bootstrap — the retired main.tsx
 * wrapper is gone, so this module is the single entry the html loads
 * (the doctrine of the 2.1.0 universal interface: one tsx app, the
 * router and the mount live together). */
if (typeof document !== "undefined" && document.getElementById("root")) {
  createRoot(document.getElementById("root")!).render(<App />);
}

export default App;
