import React from "react";
import type { ConfigError } from "../lib/env";

export function ConfigErrorScreen({ error }: { error: ConfigError }) {
  return (
    <div className="page">
      <div className="config-error-screen">
        <span className="config-error-badge">Configuration error</span>
        <h1>This deployment isn't configured yet</h1>
        <p>{error.message}</p>
        <div className="config-error-code">
          <div>VITE_AGENTLEDGER_CONTRACT_ADDRESS=0x…</div>
          <div>VITE_AGENTLEDGER_CHAIN=testnetBradbury</div>
        </div>
        <p className="config-error-note">
          Set both at build time and redeploy. See the project README for the full list of environment
          variables this app needs in production.
        </p>
      </div>
    </div>
  );
}
