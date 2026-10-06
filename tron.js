import "dotenv/config";
import { HDKey } from "@scure/bip32";
import { mnemonicToSeedSync, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { secp256k1 } from "@noble/curves/secp256k1.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import bs58check from "bs58check";

// MetaMask (snap-tron-wallet) derives at m/44'/195'/0'/0/{index} and varies
// ONLY the last index per account. account/change stay fixed at 0'/0.
const ACCOUNT = 0;
const CHANGE = 0;

export const TRONGRID = process.env.TRONGRID_URL ?? "https://api.trongrid.io";
export const USDT_CONTRACT = process.env.USDT_CONTRACT ?? "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
export const SUN = 1_000_000; // 1 TRX = 1e6 SUN; USDT-TRC20 also uses 6 decimals

export function toTronAddress(privateKey) {
  const publicKey = secp256k1.getPublicKey(privateKey, false);
  const hash = keccak_256(publicKey.slice(1)); // without the 0x04 prefix
  const payload = new Uint8Array(21);
  payload[0] = 0x41;
  payload.set(hash.slice(-20), 1);
  return bs58check.encode(payload);
}

// Base58 address → 21 bytes (0x41 + 20). Throws if the checksum or prefix is
// wrong, so a typo in the address doesn't end up as lost funds.
export function decodeAddress(address) {
  let bytes;
  try {
    bytes = Buffer.from(bs58check.decode(address.trim()));
  } catch {
    throw new Error(`Dirección TRON inválida (checksum): ${address}`);
  }
  if (bytes.length !== 21 || bytes[0] !== 0x41) {
    throw new Error(`Dirección TRON inválida (no es T...): ${address}`);
  }
  return bytes;
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function trongrid(path, init = {}, intentos = 5) {
  const headers = {
    ...init.headers,
    ...(process.env.TRONGRID_API_KEY
      ? { "TRON-PRO-API-KEY": process.env.TRONGRID_API_KEY }
      : {}),
  };

  let res;
  for (let intento = 0; intento < intentos; intento++) {
    res = await fetch(`${TRONGRID}${path}`, { ...init, headers });
    // Without an API key TronGrid throttles aggressively; retry with backoff.
    if (res.status !== 429) break;
    await sleep(1000 * 2 ** intento);
  }
  if (!res.ok) {
    const extra = res.status === 429 ? " (probá con TRONGRID_API_KEY)" : "";
    throw new Error(`TronGrid respondió ${res.status} ${res.statusText}${extra}`);
  }
  return res.json();
}

export const post = (path, body) =>
  trongrid(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

// A TRC-20 balance does NOT live in the account record: it lives in the
// contract's balanceOf mapping. An account that only received USDT doesn't
// exist on-chain (on TRON only receiving TRX activates it), so we have to ask
// the contract. Returns raw units (BigInt): 1 USDT = 1_000_000n.
export async function getTrc20Balance(address, contrato) {
  const hex20 = decodeAddress(address).subarray(1).toString("hex");
  const { constant_result } = await post("/wallet/triggerconstantcontract", {
    owner_address: address,
    contract_address: contrato,
    function_selector: "balanceOf(address)",
    parameter: hex20.padStart(64, "0"),
    visible: true,
  });
  if (!constant_result?.[0]) return 0n;
  return BigInt(`0x${constant_result[0]}`);
}

// HD master key from MNEMONIC/PASSPHRASE in .env.
export function masterFromEnv() {
  const mnemonic = process.env.MNEMONIC?.trim().replace(/\s+/g, " ").toLowerCase();
  if (!mnemonic) {
    throw new Error("Falta MNEMONIC (o PRIVATE_KEY) en .env");
  }
  if (!validateMnemonic(mnemonic, wordlist)) {
    throw new Error(
      "Mnemónica inválida: checksum incorrecto. Revisá el orden y la ortografía de las palabras."
    );
  }
  // Optional BIP39 passphrase (the "25th word"). Empty = MetaMask's default.
  const passphrase = process.env.PASSPHRASE ?? "";
  return HDKey.fromMasterSeed(mnemonicToSeedSync(mnemonic, passphrase));
}

export function derivePath(index) {
  return `m/44'/195'/${ACCOUNT}'/${CHANGE}/${index}`;
}

// PRIVATE_KEY from .env, validated, or undefined if not set.
export function privateKeyFromEnv() {
  const hex = process.env.PRIVATE_KEY?.trim().replace(/^0x/, "");
  if (!hex) return undefined;
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("PRIVATE_KEY debe ser 64 caracteres hex (32 bytes).");
  }
  return Buffer.from(hex, "hex");
}
