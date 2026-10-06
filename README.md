# Metamask-Tron-Derivation-Path

Minimal Node.js scripts for using a TRON wallet created in MetaMask **without MetaMask**. From the seed phrase they derive the same addresses MetaMask shows, read their TRX and USDT balances, and send USDT (TRC-20).

They don't use TronWeb or any other large SDK. Key derivation, addresses and signatures are computed locally with the audited [`@scure`](https://github.com/paulmillr/scure-bip32) and [`@noble`](https://github.com/paulmillr/noble-curves) libraries, and the network is queried through the [TronGrid](https://www.trongrid.io/) HTTP API.

## What it's for

- **Verifying a backup**: confirm that your seed phrase really controls your MetaMask TRON address.
- **Recovering funds**: access the wallet if you lose MetaMask or the extension stops working.
- **Checking balances**: see TRX and USDT for several addresses from the same seed at once.
- **Sending USDT from a script**: with a simulation and a cost estimate before anything is signed.

## How it reproduces MetaMask's addresses

MetaMask (through its TRON snap) derives TRON keys with this BIP-44 path:

```
m/44'/195'/0'/0/{index}
```

| Segment   | Value      | Meaning                                  |
| --------- | ---------- | ---------------------------------------- |
| `44'`     | BIP-44     | Hierarchical wallet standard             |
| `195'`    | SLIP-44    | TRON coin type (Ethereum uses `60'`)     |
| `0'`      | account    | Fixed                                    |
| `0`       | change     | Fixed (external addresses)               |
| `{index}` | 0, 1, 2…   | One address per MetaMask account         |

MetaMask creates new accounts by varying only the last index: the first account uses index 0, the second index 1, and so on. If you ever removed or imported accounts, the order may not match. That's why `read-balances.js` can scan the first N addresses (`SCAN`) so you can find yours.

This is how the seed phrase becomes a `T...` address:

```
seed phrase (+ optional passphrase)
  └─ BIP-39   → 64-byte seed
     └─ BIP-32   → private key at m/44'/195'/0'/0/{index}
        └─ secp256k1 → uncompressed public key (65 bytes)
           └─ keccak256(public key without the 0x04 byte) → last 20 bytes
              └─ 0x41 prefix + base58check → T...
```

The algorithm is the same as Ethereum's except for the `0x41` prefix and the base58check encoding. Because the path uses a different coin type (`195'` instead of `60'`), the same seed yields a TRON address unrelated to your Ethereum `0x...` address.

## Requirements

- Node.js 18 or later (uses the built-in `fetch`)
- Dependencies: `npm install`

## Configuration

Copy the example and fill it in:

```bash
cp .env.example .env
```

| Variable           | Script             | Description                                                                                  |
| ------------------ | ------------------ | -------------------------------------------------------------------------------------------- |
| `MNEMONIC`         | both               | 12- or 24-word seed phrase, words separated by spaces.                                       |
| `PASSPHRASE`       | both               | Optional BIP-39 passphrase (the "25th word"). MetaMask doesn't use one: leave it empty.      |
| `PRIVATE_KEY`      | both               | Alternative to the seed: 64-hex-character private key exported from MetaMask. If set, it takes precedence over `MNEMONIC`. |
| `SCAN`             | `read-balances.js` | How many addresses to derive and print.                                                      |
| `ADDRESS_INDEX`    | `send-usdt.js`     | Index of the source account (the one you found with `read-balances.js`). Defaults to 0.      |
| `TO_ADDRESS`       | `send-usdt.js`     | Destination address for the transfer.                                                        |
| `TRONGRID_API_KEY` | both               | Optional but recommended (it's free). Without a key, TronGrid rate-limits requests and the scripts get slow. |
| `TRONGRID_URL`     | both               | Node to use. Defaults to mainnet (`https://api.trongrid.io`).                                |
| `USDT_CONTRACT`    | both               | USDT contract. Defaults to mainnet (`TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`).                   |

The scripts' console output is in Spanish; the examples below show it as printed.

## Reading balances: `read-balances.js`

```bash
node read-balances.js
```

Prints each derived address with its path and balances:

```
 0  m/44'/195'/0'/0/0  TXk2...  12.500000 TRX  |  100.000000 USDT
 1  m/44'/195'/0'/0/1  TQ9a...  0.000000 TRX  |  0.000000 USDT  |  cuenta SIN activar (necesita TRX para operar)
```

Compare the addresses with the ones MetaMask shows to tell which index belongs to each account.

**"cuenta SIN activar" (account not activated)**: on TRON, an account only exists on-chain once it receives TRX. Receiving USDT isn't enough to activate it. The USDT is still there, but to move it the account needs TRX to pay the fee.

## Sending USDT: `send-usdt.js`

The amount is fixed in the script, in the `MONTO_USDT` constant at the top. The destination comes from `TO_ADDRESS` in `.env`.

**1. Simulate** (sends nothing):

```bash
node send-usdt.js
```

```
Red:        https://api.trongrid.io
Origen:     TXk2...  (m/44'/195'/0'/0/0)
Destino:    TBXS...
Monto:      1.000000 USDT
Saldo:      100.000000 USDT  |  12.500000 TRX
Energía:    64285 (disponible: 0) → 6.428500 TRX
Bandwidth:  345 bytes (disponible: 600 gratis, 0 stake) → 0.000000 TRX
Costo est.: ~6.428500 TRX  (fee_limit 50 TRX)
TxID:       64dd8f38...

Simulación OK, no se envió nada. Para mandarlo de verdad:  node send-usdt.js --send
```

**2. Send**:

```bash
node send-usdt.js --send
```

The script signs, broadcasts the transaction and waits for it to land in a block (about 3 seconds). It then prints the result, the TRX burned and the Tronscan link.

### What it costs

A USDT transfer consumes **energy**, which is paid by burning TRX unless you have staked energy. It also consumes **bandwidth**, of which every account gets 600 free bytes per day. At the October 2026 energy price (100 SUN per unit):

| Case                                   | Approx. energy | Approx. TRX burned |
| -------------------------------------- | -------------- | ------------------ |
| Destination already holds USDT         | ~65,000        | ~6.5 TRX           |
| Destination holds 0 USDT               | ~130,000       | ~13 TRX            |
| Bandwidth, once the free bytes are used | ~345 bytes    | ~0.35 TRX          |

These numbers change. The script computes them on every run from the simulation and the current network parameters. `FEE_LIMIT_TRX` (50 TRX) is only a cap: you're charged for what is actually consumed.

### What it checks before signing

- That `TO_ADDRESS` is a valid TRON address (correct checksum) and isn't the USDT contract, since tokens sent there are lost.
- That the source account is activated and has enough USDT and TRX.
- That the simulated `transfer` doesn't revert.
- That the transaction TronGrid builds is exactly the one requested: it decodes it locally, compares the source, contract, destination, amount and `fee_limit`, and checks that the `txID` is the hash of those bytes.

Signing happens locally. The same bytes that were verified are broadcast with `broadcasthex`.

## Testing on testnet (Nile)

To practice without real funds, point the scripts at the Nile testnet and get test TRX from its faucet:

```bash
TRONGRID_URL="https://nile.trongrid.io"
USDT_CONTRACT="TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf"  # verify it on nile.tronscan.org
```

## Security

- **The seed phrase in `.env` gives full control over all your MetaMask accounts**, including Ethereum and every other network, not just TRON. `.env` is in `.gitignore`: never commit or share it.
- The seed never leaves your machine. Keys are derived locally, and TronGrid only receives public addresses and already-signed transactions.
- For your first transfer, send a small amount to an address you control.
- When you're done, remove the seed from `.env`.

## Files

| File               | Contents                                                                    |
| ------------------ | --------------------------------------------------------------------------- |
| `tron.js`          | Shared helpers: derivation, addresses, TronGrid client and TRC-20 balance   |
| `read-balances.js` | Derives addresses and prints their TRX and USDT balances                    |
| `send-usdt.js`     | Simulates or sends a USDT transfer                                          |
| `.env.example`     | Configuration template                                                      |
