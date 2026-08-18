import React, { useEffect, useState } from "react";
import Landing from "./pages/Landing";
import AppView from "./pages/AppView";

type Route = "landing" | "app";

function routeFromHash(): Route {
  return window.location.hash === "#/app" ? "app" : "landing";
}

export default function App() {
  const [route, setRoute] = useState<Route>(routeFromHash());

  useEffect(() => {
    const onHashChange = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  function goToApp() {
    window.location.hash = "#/app";
    setRoute("app");
  }

  function goToLanding() {
    window.location.hash = "#/";
    setRoute("landing");
  }

  return route === "app" ? <AppView onBackToLanding={goToLanding} /> : <Landing onLaunch={goToApp} />;
}
