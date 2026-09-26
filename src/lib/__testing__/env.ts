// Side-effect import for tests: `import "./__testing__/env";` FIRST in a test file.
// Prisma Client loads the project's .env into process.env for every key that is unset, which would hand tests
// the real Helius key, RPC URLs and seal keys. Pre-set them to inert local values (tests may override them in
// their body before dynamically importing the module under test).

const INERT: Record<string, string> = {
  COPYFOMO_MODE: "paper",
  DATABASE_URL: "file:./__test_no_such_dir__/none.db",
  HELIUS_API_KEY: "",
  HELIUS_PLAN: "free",
  SOLANA_RPC_URL: "http://127.0.0.1:9/",
  SOLANA_WS_URL: "ws://127.0.0.1:9/",
  JUPITER_API_URL: "http://127.0.0.1:9",
  JUPITER_API_KEY: "",
  WALLET_SEAL_PUBLIC_KEY: "",
  WALLET_SEAL_PRIVATE_KEY: "",
  SESSION_SECRET: "",
  PLATFORM_FEE_WALLET: "",
  FOMO_INDEXER: "off",
};

for (const [key, value] of Object.entries(INERT)) {
  if (process.env[key] === undefined) process.env[key] = value;
}

export {};
