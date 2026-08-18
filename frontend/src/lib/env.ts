import { AVAILABLE_CHAINS, type ChainName } from "./wallet";

/**
 * Production configuration. Both values are baked in at build time via Vite
 * env vars (see .env.example / README) -- there is no runtime input for
 * either. If either is missing or invalid, the app renders a configuration
 * error instead of a form, since asking the person using the app to type in
 * a contract address is exactly what this was built to avoid.
 */
export interface AppConfig {
  contractAddress: `0x${string}`;
  chainName: ChainName;
}

export interface ConfigError {
  message: string;
}

export function loadConfig(): { config: AppConfig | null; error: ConfigError | null } {
  const rawAddress = import.meta.env?.VITE_AGENTLEDGER_CONTRACT_ADDRESS as string | undefined;
  const rawChain = import.meta.env?.VITE_AGENTLEDGER_CHAIN as string | undefined;

  if (!rawAddress || !rawChain) {
    return {
      config: null,
      error: {
        message:
          "This deployment is missing its contract configuration. VITE_AGENTLEDGER_CONTRACT_ADDRESS and VITE_AGENTLEDGER_CHAIN must be set at build time.",
      },
    };
  }

  if (!/^0x[a-fA-F0-9]{40}$/.test(rawAddress)) {
    return {
      config: null,
      error: { message: `VITE_AGENTLEDGER_CONTRACT_ADDRESS is not a valid address: "${rawAddress}"` },
    };
  }

  if (!AVAILABLE_CHAINS.includes(rawChain as ChainName)) {
    return {
      config: null,
      error: {
        message: `VITE_AGENTLEDGER_CHAIN is "${rawChain}", which isn't one of the chains this build of genlayer-js knows about (${AVAILABLE_CHAINS.join(", ")}).`,
      },
    };
  }

  return {
    config: { contractAddress: rawAddress as `0x${string}`, chainName: rawChain as ChainName },
    error: null,
  };
}
