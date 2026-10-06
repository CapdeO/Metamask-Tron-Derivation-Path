import { secp256k1 } from "@noble/curves/secp256k1.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { keccak_256 } from "@noble/hashes/sha3.js";
import {
  SUN,
  TRONGRID,
  USDT_CONTRACT,
  decodeAddress,
  derivePath,
  getTrc20Balance,
  masterFromEnv,
  post,
  privateKeyFromEnv,
  sleep,
  toTronAddress,
} from "./tron.js";

// Fixed amount sent on every run. A string to avoid floating-point errors.
const MONTO_USDT = "3";

// Cap on the TRX the network may burn for energy. Only what is used gets charged;
// if the cap is too low the tx fails (OUT_OF_ENERGY) and whatever was burned is lost.
const FEE_LIMIT_TRX = 50;

const DECIMALES = 6;
const TRIGGER_SMART_CONTRACT = 31n; // Transaction.Contract.ContractType

// Without --send it only simulates: builds the tx, verifies it and shows the estimated cost.
const ENVIAR = process.argv.includes("--send");

function parseUnits(monto, decimales) {
  const match = /^(\d+)(?:\.(\d+))?$/.exec(monto.trim());
  if (!match) throw new Error(`Monto inválido: ${monto}`);
  const [, entero, frac = ""] = match;
  if (frac.length > decimales) {
    throw new Error(`El monto tiene más de ${decimales} decimales: ${monto}`);
  }
  return BigInt(entero + frac.padEnd(decimales, "0"));
}

const formatUnits = (raw) => (Number(raw) / 10 ** DECIMALES).toFixed(DECIMALES);
const formatTrx = (sun) => `${(Number(sun) / SUN).toFixed(6)} TRX`;

// java-tron sometimes returns error messages hex-encoded.
const decodeMessage = (msg = "") =>
  /^([0-9a-f]{2})+$/i.test(msg) ? Buffer.from(msg, "hex").toString("utf8") : msg;

// Minimal protobuf decoder: enough to read Transaction.raw and check that what
// TronGrid built is exactly what we mean to sign.
function decodeProto(bytes) {
  const campos = {};
  let i = 0;
  const varint = () => {
    let valor = 0n;
    for (let shift = 0n; ; shift += 7n) {
      const b = bytes[i++];
      if (b === undefined) throw new Error("protobuf truncado");
      valor |= BigInt(b & 0x7f) << shift;
      if (b < 0x80) return valor;
    }
  };
  while (i < bytes.length) {
    const tag = varint();
    let valor;
    switch (Number(tag & 7n)) {
      case 0: valor = varint(); break;
      case 1: valor = bytes.subarray(i, (i += 8)); break;
      case 2: { const len = Number(varint()); valor = bytes.subarray(i, (i += len)); break; }
      case 5: valor = bytes.subarray(i, (i += 4)); break;
      default: throw new Error(`protobuf: wire type ${tag & 7n} no soportado`);
    }
    (campos[Number(tag >> 3n)] ??= []).push(valor);
  }
  if (i !== bytes.length) throw new Error("protobuf truncado");
  return campos;
}

function encodeVarint(n) {
  const out = [];
  for (; n >= 0x80; n >>>= 7) out.push((n & 0x7f) | 0x80);
  out.push(n);
  return Buffer.from(out);
}

// Field numbers from core/Tron.proto and core/contract/smart_contract.proto.
function verificarTx(tx, { owner, contrato, data, feeLimit }) {
  const raw = Buffer.from(tx.raw_data_hex, "hex");
  if (Buffer.from(sha256(raw)).toString("hex") !== tx.txID) {
    throw new Error("txID no coincide con sha256(raw_data_hex)");
  }

  const rawData = decodeProto(raw);
  const contratos = rawData[11] ?? [];
  if (contratos.length !== 1) throw new Error(`La tx trae ${contratos.length} contratos, esperaba 1`);

  const contract = decodeProto(contratos[0]);
  if (contract[1]?.[0] !== TRIGGER_SMART_CONTRACT) throw new Error("La tx no es TriggerSmartContract");
  if (contract[5]?.[0]) throw new Error("La tx usa un permission_id distinto de owner");

  const trigger = decodeProto(decodeProto(contract[2][0])[2][0]);
  const igual = (a, b) => a !== undefined && Buffer.compare(Buffer.from(a), b) === 0;
  const chequeos = {
    owner_address: igual(trigger[1]?.[0], owner),
    contract_address: igual(trigger[2]?.[0], contrato),
    data: igual(trigger[4]?.[0], data),
    call_value: !trigger[3]?.[0],
    call_token_value: !trigger[5]?.[0],
    fee_limit: rawData[18]?.[0] === BigInt(feeLimit),
  };
  const fallidos = Object.keys(chequeos).filter((k) => !chequeos[k]);
  if (fallidos.length) {
    throw new Error(`La tx que armó TronGrid no coincide en: ${fallidos.join(", ")}`);
  }
  return raw;
}

function firmar(txID, privateKey) {
  const sig = secp256k1.sign(Buffer.from(txID, "hex"), privateKey, {
    prehash: false, // txID is already sha256(raw)
    format: "recovered",
  });
  // noble returns [recovery, r, s]; TRON expects r || s || v with v = recovery + 27.
  return Buffer.concat([sig.subarray(1), Buffer.from([sig[0] + 27])]);
}

function tronscan(txID) {
  const red = TRONGRID.match(/nile|shasta/)?.[0];
  return `https://${red ? `${red}.` : ""}tronscan.org/#/transaction/${txID}`;
}

// --- Source key --------------------------------------------------------------

let privateKey = privateKeyFromEnv();
let origenPath = "PRIVATE_KEY";
if (!privateKey) {
  // ADDRESS_INDEX = the index read-balances.js printed (with SCAN) for your MetaMask account.
  const index = Number(process.env.ADDRESS_INDEX ?? 0);
  if (!Number.isInteger(index) || index < 0) {
    throw new Error("ADDRESS_INDEX debe ser un entero >= 0");
  }
  origenPath = derivePath(index);
  privateKey = masterFromEnv().derive(origenPath).privateKey;
}
const origen = toTronAddress(privateKey);

// --- Destination and amount --------------------------------------------------

const destino = process.env.TO_ADDRESS?.trim();
if (!destino) throw new Error("Falta TO_ADDRESS en .env");
const destinoBytes = decodeAddress(destino);
if (destino === USDT_CONTRACT) {
  throw new Error("TO_ADDRESS es el contrato de USDT: los tokens quedarían perdidos.");
}

const monto = parseUnits(MONTO_USDT, DECIMALES);
if (monto <= 0n) throw new Error("El monto debe ser mayor a 0");

// transfer(address,uint256): 20-byte address and amount, each padded to 32 bytes.
const parameter =
  destinoBytes.subarray(1).toString("hex").padStart(64, "0") +
  monto.toString(16).padStart(64, "0");
const llamada = {
  owner_address: origen,
  contract_address: USDT_CONTRACT,
  function_selector: "transfer(address,uint256)",
  parameter,
  visible: true,
};

// --- Pre-flight checks -------------------------------------------------------

const [cuenta, saldoUsdt, recursos, { chainParameter }, simulacion] = await Promise.all([
  post("/wallet/getaccount", { address: origen, visible: true }),
  getTrc20Balance(origen, USDT_CONTRACT),
  post("/wallet/getaccountresource", { address: origen, visible: true }),
  post("/wallet/getchainparameters", {}),
  post("/wallet/triggerconstantcontract", llamada),
]);

const parametro = (key) => BigInt(chainParameter.find((p) => p.key === key)?.value ?? 0);
const saldoTrx = BigInt(cuenta.balance ?? 0);

console.log(`Red:        ${TRONGRID}`);
console.log(`Origen:     ${origen}  (${origenPath})`);
console.log(`Destino:    ${destino}`);
console.log(`Monto:      ${formatUnits(monto)} USDT`);
console.log(`Saldo:      ${formatUnits(saldoUsdt)} USDT  |  ${formatTrx(saldoTrx)}`);

if (!cuenta.address) {
  throw new Error("La cuenta origen no está activada: mandale algo de TRX primero.");
}
if (saldoUsdt < monto) {
  throw new Error("Saldo de USDT insuficiente.");
}
if (destino === origen) {
  console.warn("Ojo: origen y destino son la misma dirección (solo vas a gastar TRX).");
}

// The USDT contract on TRON returns false even when the transfer succeeds, so
// success is confirmed by the Transfer event, not by constant_result.
const revirtio =
  simulacion.transaction?.ret?.[0]?.ret === "FAILED" ||
  !simulacion.result?.result ||
  !simulacion.logs?.length;
if (revirtio) {
  throw new Error(
    `La simulación del transfer falló: ${decodeMessage(simulacion.result?.message) || "sin detalle"}`
  );
}

// --- Build and verify the tx -------------------------------------------------

const feeLimit = FEE_LIMIT_TRX * SUN;
const armado = await post("/wallet/triggersmartcontract", { ...llamada, fee_limit: feeLimit, call_value: 0 });
if (!armado.result?.result || !armado.transaction) {
  throw new Error(`TronGrid no pudo armar la tx: ${decodeMessage(armado.result?.message)}`);
}
const tx = armado.transaction;
const raw = verificarTx(tx, {
  owner: decodeAddress(origen),
  contrato: decodeAddress(USDT_CONTRACT),
  // data = first 4 bytes of keccak256(function signature) + parameters.
  data: Buffer.concat([
    keccak_256(Buffer.from(llamada.function_selector)).subarray(0, 4),
    Buffer.from(parameter, "hex"),
  ]),
  feeLimit,
});

// Sign + Transaction proto: raw_data (field 1) and signature (field 2).
// A simulation doesn't sign: a zeroed signature is enough to measure the size.
const firma = ENVIAR ? firmar(tx.txID, privateKey) : Buffer.alloc(65);
const serializada = Buffer.concat([
  Buffer.from([0x0a]), encodeVarint(raw.length), raw,
  Buffer.from([0x12]), encodeVarint(firma.length), firma,
]);

// --- Estimated cost ----------------------------------------------------------

// Energy: staked energy is consumed first; the rest is paid by burning TRX.
const energia = BigInt(simulacion.energy_used ?? 0);
const energiaDisponible = BigInt((recursos.EnergyLimit ?? 0) - (recursos.EnergyUsed ?? 0));
const energiaAPagar = energia > energiaDisponible ? energia - energiaDisponible : 0n;
const costoEnergia = energiaAPagar * parametro("getEnergyFee");

// Bandwidth: tx size + 64 bytes for the result. If neither the free daily
// allowance (600) nor staked bandwidth covers it, the whole size is burned at
// getTransactionFee SUN/byte.
const bytes = BigInt(serializada.length + 64);
const netGratis = BigInt((recursos.freeNetLimit ?? 0) - (recursos.freeNetUsed ?? 0));
const netStake = BigInt((recursos.NetLimit ?? 0) - (recursos.NetUsed ?? 0));
const costoBandwidth = netGratis >= bytes || netStake >= bytes ? 0n : bytes * parametro("getTransactionFee");

const costo = costoEnergia + costoBandwidth;
console.log(`Energía:    ${energia} (disponible: ${energiaDisponible}) → ${formatTrx(costoEnergia)}`);
console.log(`Bandwidth:  ${bytes} bytes (disponible: ${netGratis} gratis, ${netStake} stake) → ${formatTrx(costoBandwidth)}`);
console.log(`Costo est.: ~${formatTrx(costo)}  (fee_limit ${FEE_LIMIT_TRX} TRX)`);
console.log(`TxID:       ${tx.txID}`);

if (saldoTrx < costo) {
  throw new Error(`No alcanza el TRX para pagar la tx: tenés ${formatTrx(saldoTrx)}.`);
}
if (costoEnergia > BigInt(feeLimit)) {
  throw new Error(`La energía estimada supera el fee_limit: subí FEE_LIMIT_TRX.`);
}

if (!ENVIAR) {
  console.log("\nSimulación OK, no se envió nada. Para mandarlo de verdad:  node send-usdt.js --send");
  process.exit(0);
}

// --- Send --------------------------------------------------------------------

// broadcasthex sends exactly the bytes we verified and signed.
const enviado = await post("/wallet/broadcasthex", { transaction: serializada.toString("hex") });
if (!enviado.result) {
  throw new Error(`Broadcast rechazado: ${enviado.code} ${decodeMessage(enviado.message)}`);
}
console.log(`\nEnviada: ${tronscan(tx.txID)}`);

// Blocks every ~3 s; wait for the tx to land in one to see the result.
for (let intento = 0; intento < 20; intento++) {
  await sleep(3000);
  const info = await post("/wallet/gettransactioninfobyid", { value: tx.txID });
  if (!info.id) continue;
  const resultado = info.receipt?.result ?? "SUCCESS";
  console.log(`Resultado:  ${resultado} en el bloque ${info.blockNumber}`);
  console.log(`Quemado:    ${formatTrx(info.fee ?? 0)}  (energía usada: ${info.receipt?.energy_usage_total ?? 0})`);
  process.exit(resultado === "SUCCESS" ? 0 : 1);
}
console.log("Todavía no entró en un bloque; revisala en Tronscan.");
