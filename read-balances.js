import {
  SUN,
  USDT_CONTRACT,
  derivePath,
  getTrc20Balance,
  masterFromEnv,
  privateKeyFromEnv,
  sleep,
  toTronAddress,
  trongrid,
} from "./tron.js";

async function getBalance(address) {
  const [cuenta, usdt] = await Promise.all([
    trongrid(`/v1/accounts/${address}`),
    getTrc20Balance(address, USDT_CONTRACT),
  ]);
  const account = cuenta.data?.[0];
  return {
    activada: Boolean(account),
    trx: Number(account?.balance ?? 0) / SUN,
    usdt: Number(usdt) / SUN,
  };
}

function formatBalance(balance) {
  const parts = [
    `${balance.trx.toFixed(6)} TRX`,
    `${balance.usdt.toFixed(6)} USDT`,
  ];
  // Without TRX there's no way to pay for energy/bandwidth: the USDT is there but can't move.
  if (!balance.activada) parts.push("cuenta SIN activar (necesita TRX para operar)");
  return parts.join("  |  ");
}

async function report(address, prefix = "") {
  let balance;
  try {
    balance = formatBalance(await getBalance(address));
  } catch (err) {
    balance = `error al consultar balance: ${err.message}`;
  }
  console.log(`${prefix}${address}  ${balance}`);
}

// Path A: private key exported directly from MetaMask.
const privateKey = privateKeyFromEnv();
if (privateKey) {
  await report(toTronAddress(privateKey));
  process.exit(0);
}

// Path B: derivation from the seed phrase.
const master = masterFromEnv();

// SCAN=N prints the first N addresses so you can find the MetaMask one.
// Sequential on purpose: TronGrid allows ~15 req/s without an API key.
const scan = Number(process.env.SCAN ?? 1);
for (let i = 0; i < scan; i++) {
  const path = derivePath(i);
  const child = master.derive(path);
  await report(toTronAddress(child.privateKey), `${String(i).padStart(2)}  ${path}  `);
  if (i < scan - 1) await sleep(1000);
}
